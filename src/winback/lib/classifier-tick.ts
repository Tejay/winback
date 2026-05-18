import { db } from '@/lib/db'
import { churnedSubscribers, customers } from '@/lib/schema'
import { and, eq, isNull, asc, lt, sql, count } from 'drizzle-orm'
import { classifySubscriber } from './classifier'
import { scheduleExitEmail } from './email'
import { logEvent } from './events'
import type { ClassificationResult, SubscriberSignals } from './types'
import { buildConversationThread } from './conversation'
import { deriveTriggerNeedConfidence } from './improvement-match'
import { isCustomerBillingHealthy } from './billing-enforcement'

/**
 * Spec 72 — consumer side of the producer/consumer pipeline.
 *
 * Picks rows with classified_at = NULL, calls the LLM, persists the
 * classification, and runs downstream actions (exit email when recent
 * and the AI doesn't suppress). Bounded batch per tick so we stay
 * under Vercel's function ceiling.
 *
 * Failure model:
 *   - Per-row try/catch increments classify_attempts on the row
 *   - After 3 failed attempts, the row drops out of the WHERE clause
 *     (lt(classify_attempts, 3)) and emits a classify_dead_lettered
 *     event for admin attention.
 *   - The cron itself never throws — failures are per-row.
 */

// Spec 72 — dropped from 30 → 20 after load testing. Anthropic latency
// is ~4-5s per LLM call (worse than my original ~1.5s estimate). A
// fully-signal batch of 20 takes ~100s, comfortably under the 300s
// function ceiling. A batch of 30 could spike to ~150s+ and risk a
// Vercel timeout on the worst-case batch composition.
const BATCH_PER_TICK = 20
const DEAD_LETTER_THRESHOLD = 3
// Spec 72 — 90-day window for BOTH paths (silent-churn ask + signal-bearing
// tier 1/2 personalized emails).
//
// Originally 7 days for signal-bearing to avoid stale references, but the
// classifier prompt has its own age-awareness baked in (suppresses 14-60d
// rows without strong reason; suppresses 60+ rows without compelling match).
// So the code gate was redundant — the LLM is already the judge of "is this
// stale". Going to 90d uniformly means more recovery shots on backfill
// without spam, since the LLM filters at the edges.
const EMAIL_RECENCY_DAYS = 90

export interface ClassifierTickStats {
  picked:          number
  classified:      number
  failed:          number
  deadLettered:    number
  exitEmailsSent:  number
  errors:          string[]
}

/**
 * Hot-path filter: skip the LLM call entirely when there's no signal
 * to interpret (no stripe_enum AND no stripe_comment). Saves ~$0.003
 * per silent-churn row.
 */
export function hasSignalForLLM(s: { stripeEnum: string | null; stripeComment: string | null }): boolean {
  return !!(s.stripeEnum || s.stripeComment)
}

/**
 * Deterministic classification for silent churn — the no-LLM fallback
 * matched against the same ClassificationResult shape the LLM produces.
 */
export function classifySilentChurn(): Omit<ClassificationResult, 'firstMessage'> & { firstMessage: null } {
  return {
    tier: 3,
    tierReason: 'Silent churn — no cancellation reason provided',
    cancellationReason: 'No reason given',
    cancellationCategory: 'Other',
    confidence: 0.3,
    suppress: false,
    firstMessage: null,
    triggerKeyword: null,
    triggerNeed: null,
    winBackSubject: '',
    winBackBody: '',
    handoff: false,
    handoffReasoning: 'Silent-churn — no signal to judge; defaulting to no hand-off.',
    recoveryLikelihood: 'low',
  }
}

export async function runClassifierTick(): Promise<ClassifierTickStats> {
  const stats: ClassifierTickStats = {
    picked: 0, classified: 0, failed: 0, deadLettered: 0,
    exitEmailsSent: 0, errors: [],
  }

  // Pick oldest-first to keep latency bounded for the longest-waiting row.
  const rows = await db
    .select()
    .from(churnedSubscribers)
    .where(and(
      isNull(churnedSubscribers.classifiedAt),
      lt(churnedSubscribers.classifyAttempts, DEAD_LETTER_THRESHOLD),
    ))
    .orderBy(asc(churnedSubscribers.createdAt))
    .limit(BATCH_PER_TICK)

  stats.picked = rows.length

  for (const sub of rows) {
    try {
      // Customer context for the classifier prompt (founder name, etc.)
      const [customer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, sub.customerId))
        .limit(1)
      if (!customer) {
        throw new Error(`customer ${sub.customerId} not found`)
      }

      // 2026-05-18 — billing-health gate. Skip classification (and the
      // ~$0.003 Anthropic spend) for merchants whose platform sub is in
      // a non-paying state. Leaves classified_at NULL so the row
      // resumes automatically once billing heals (the 5-min cache in
      // billing-enforcement.ts expires + the next tick re-checks).
      if (!(await isCustomerBillingHealthy(sub.customerId))) {
        await logEvent({
          name: 'classifier_skipped_billing_unhealthy',
          customerId: sub.customerId,
          properties: { subscriberId: sub.id },
        })
        continue
      }

      // Skip the LLM call when there's no signal to interpret. Track
      // the path so we can apply the right recency window + populate
      // the silent-churn ask template downstream.
      const isSilentChurn = !hasSignalForLLM({ stripeEnum: sub.stripeEnum, stripeComment: sub.stripeComment })
      let classification: ClassificationResult
      if (isSilentChurn) {
        const base = classifySilentChurn()
        // Even with no signal, we send a generic "would love to know
        // why you left" exit email. Reply rate is low (industry: 5-15%)
        // but every reply is gold — it gives the inbound webhook a real
        // string to re-classify against. No LLM call here; tier-3 voice
        // rules are baked into the template directly.
        const firstName = (sub.name?.split(' ')[0]) ?? 'there'
        const productName = customer.productName ?? 'us'
        const founderName = customer.founderName ?? 'The team'
        classification = {
          ...base,
          firstMessage: {
            subject: `A quick question, ${firstName}`,
            body: `Hi ${firstName},\n\nSaw you cancelled ${productName} recently. If you have a minute, I'd love to know what we got wrong. Even one line is enough.\n\n— ${founderName}\n`,
            sendDelaySecs: 60,
          },
        }
      } else {
        const signals: SubscriberSignals = {
          stripeCustomerId:     sub.stripeCustomerId,
          stripeSubscriptionId: sub.stripeSubscriptionId ?? '',
          stripePriceId:        sub.stripePriceId ?? null,
          email:                sub.email,
          name:                 sub.name,
          planName:             sub.planName ?? 'Unknown',
          mrrCents:             sub.mrrCents,
          tenureDays:           sub.tenureDays ?? 0,
          everUpgraded:         sub.everUpgraded ?? false,
          nearRenewal:          sub.nearRenewal ?? false,
          paymentFailures:      sub.paymentFailures ?? 0,
          previousSubs:         sub.previousSubs ?? 0,
          stripeEnum:           sub.stripeEnum,
          stripeComment:        sub.stripeComment,
          conversationThread:   await buildConversationThread(sub.id),
          billingPortalClicked: !!sub.billingPortalClickedAt,
          cancelledAt:          sub.cancelledAt ?? new Date(),
        }
        classification = await classifySubscriber(signals, {
          founderName: customer.founderName ?? undefined,
          productName: customer.productName ?? undefined,
        })
      }

      // Persist + mark classified atomically.
      //
      // Spec 72 — funnel transition logic:
      // - Signal-bearing rows: derive triggerNeedConfidence from the
      //   real LLM output and persist. This unlocks V2 re-engagement
      //   eligibility without V2 having to make its own LLM call.
      // - Silent-churn rows: leave triggerNeedConfidence NULL. The
      //   semantics are "not yet judged" — we have no signal to judge
      //   from. If a reply later turns this into has-signal, the
      //   inbound webhook re-derives and persists at that point.
      const persisted: Record<string, unknown> = {
        tier:                 classification.tier,
        confidence:           String(classification.confidence),
        cancellationReason:   classification.cancellationReason,
        cancellationCategory: classification.cancellationCategory,
        triggerKeyword:       classification.triggerKeyword,
        triggerNeed:          classification.triggerNeed,
        winBackSubject:       classification.winBackSubject,
        winBackBody:          classification.winBackBody,
        handoffReasoning:     classification.handoffReasoning,
        recoveryLikelihood:   classification.recoveryLikelihood,
        status:               classification.tier === 4 ? 'skipped' : (sub.status ?? 'pending'),
        classifiedAt:         new Date(),
        updatedAt:            new Date(),
      }
      if (!isSilentChurn) {
        persisted.triggerNeedConfidence = deriveTriggerNeedConfidence(classification)
      }
      await db
        .update(churnedSubscribers)
        .set(persisted)
        .where(eq(churnedSubscribers.id, sub.id))

      stats.classified++
      await logEvent({
        name: 'subscriber_classified',
        customerId: customer.id,
        properties: { subscriberId: sub.id, tier: classification.tier },
      })

      // Downstream: schedule exit email when the cancellation is recent
      // and the AI didn't suppress. 90-day window applies to both paths
      // (silent-churn ask + signal-bearing tier 1/2). The classifier
      // prompt's own age-awareness handles staleness within the window.
      const cancelledAt = sub.cancelledAt
      const isRecent = !!cancelledAt &&
        (Date.now() - cancelledAt.getTime()) < EMAIL_RECENCY_DAYS * 24 * 60 * 60 * 1000
      const shouldEmail = classification.tier !== 4
        && !classification.suppress
        && classification.firstMessage !== null
        && !!sub.email
        && isRecent

      if (shouldEmail) {
        try {
          await scheduleExitEmail({
            subscriberId: sub.id,
            email: sub.email!,
            classification,
            fromName: customer.founderName ?? 'The team',
          })
          stats.exitEmailsSent++
        } catch (emailErr) {
          // Email failure doesn't roll back the classification.
          await logEvent({
            name: 'exit_email_failed',
            customerId: customer.id,
            properties: {
              subscriberId: sub.id,
              errorMessage: emailErr instanceof Error ? emailErr.message : String(emailErr),
            },
          })
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      stats.failed++
      stats.errors.push(`${sub.id}: ${message}`)

      // Increment attempts. If we've hit the dead-letter threshold,
      // emit the dead-letter event so the admin tile + inspector
      // banner can surface it.
      const [updated] = await db
        .update(churnedSubscribers)
        .set({ classifyAttempts: sql`${churnedSubscribers.classifyAttempts} + 1` })
        .where(eq(churnedSubscribers.id, sub.id))
        .returning({ attempts: churnedSubscribers.classifyAttempts })

      await logEvent({
        name: 'classify_failed',
        customerId: sub.customerId,
        properties: {
          subscriberId: sub.id,
          attempts: updated?.attempts ?? 0,
          errorMessage: message,
        },
      })

      if ((updated?.attempts ?? 0) >= DEAD_LETTER_THRESHOLD) {
        stats.deadLettered++
        await logEvent({
          name: 'classify_dead_lettered',
          customerId: sub.customerId,
          properties: {
            subscriberId: sub.id,
            attempts: updated?.attempts,
            lastErrorMessage: message,
          },
        })
      }
    }
  }

  return stats
}

/**
 * Count rows currently in the dead-letter state. Used by the admin
 * Overview tile.
 */
export async function countDeadLetteredRows(): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(churnedSubscribers)
    .where(and(
      isNull(churnedSubscribers.classifiedAt),
      sql`${churnedSubscribers.classifyAttempts} >= ${DEAD_LETTER_THRESHOLD}`,
    ))
  return Number(row?.n ?? 0)
}

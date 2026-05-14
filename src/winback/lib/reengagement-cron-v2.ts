import { db } from '@/lib/db'
import {
  churnedSubscribers,
  customers,
  emailsSent,
  improvements,
  improvementMatches,
} from '@/lib/schema'
import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm'
import { classifySubscriber } from './classifier'
import {
  sendEmail,
  isCustomerPausedForWinback,
  isCustomerPausedForBillingByCustomerId,
} from './email'
import {
  deriveTriggerNeedConfidence,
  findBestMatch,
  generateImprovementEmail,
  sanityCheckEmail,
  type ImprovementForMatcher,
} from './improvement-match'
import { logEvent } from './events'
import type { SubscriberSignals } from './types'

/**
 * Spec 65 Phase 3 — V2 re-engagement cron pipeline.
 * Spec 70 — per-subscriber helper extracted so the "Send re-engagement
 * now" admin action can fire the pipeline for one row, and so skip
 * events land via a single emit() helper.
 */

const BATCH_LIMIT = 50

export type SkipReason =
  | 'customer_paused'
  | 'low_confidence'
  | 'no_improvements'
  | 'no_match'
  | 'sanity_failed'
  | 'cooldown'
  | 'expired'

export type PerSubscriberOutcome =
  | { kind: 'emailed'; improvementId: string }
  | { kind: 'skipped'; reason: SkipReason }
  | { kind: 'error';   errorMessage: string }

export interface CronV2Stats {
  considered:             number
  emailed:                number
  expired:                number
  skippedCustomerPaused:  number
  skippedLowConfidence:   number
  skippedNoMatch:         number
  skippedSanity:          number
  skippedNoImprovements:  number
  errors:                 number
}

/** Subscriber row shape used by processSubscriberForReengagement. */
type SubRow = typeof churnedSubscribers.$inferSelect

/**
 * Emit a structured `reengagement_skipped` event for inspector display.
 * Standard properties: subscriberId, reason; callers add improvement
 * context where relevant. Fire-and-forget — never throws.
 */
async function emitSkipped(
  subscriberId: string,
  customerId: string,
  reason: SkipReason,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await logEvent({
      name: 'reengagement_skipped',
      customerId,
      properties: { subscriberId, reason, ...extra },
    })
  } catch (err) {
    console.warn('[reengagement-v2] emitSkipped failed:', err)
  }
}

export interface ProcessOptions {
  /** Spec 70 — admin "Send now" sets true so the 60-day cooldown is ignored. */
  bypassCooldown?: boolean
}

/**
 * Run the full re-engagement match-and-send pipeline for ONE subscriber.
 * Used by the cron in a loop and by the admin "Send re-engagement now"
 * endpoint for a single row. The expiry gate is *not* checked here — the
 * cron handles expiry separately, and admin force-fire on an expired
 * subscriber is rejected upstream by the endpoint.
 */
export async function processSubscriberForReengagement(
  sub: SubRow,
  opts: ProcessOptions = {},
): Promise<PerSubscriberOutcome> {
  try {
    // 1. Customer-level pause checks
    if (await isCustomerPausedForWinback(sub.id)) {
      await emitSkipped(sub.id, sub.customerId, 'customer_paused', { gate: 'winback' })
      return { kind: 'skipped', reason: 'customer_paused' }
    }
    if (await isCustomerPausedForBillingByCustomerId(sub.customerId)) {
      await emitSkipped(sub.id, sub.customerId, 'customer_paused', { gate: 'billing' })
      return { kind: 'skipped', reason: 'customer_paused' }
    }

    // 2. Cooldown (skippable by admin send-now)
    if (!opts.bypassCooldown && sub.lastReengagedAt) {
      const cooldownCutoff = Date.now() - 60 * 24 * 60 * 60 * 1000
      if (sub.lastReengagedAt.getTime() > cooldownCutoff) {
        await emitSkipped(sub.id, sub.customerId, 'cooldown', {
          lastReengagedAt: sub.lastReengagedAt.toISOString(),
        })
        return { kind: 'skipped', reason: 'cooldown' }
      }
    }

    // 3. Load customer
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, sub.customerId))
      .limit(1)
    if (!customer) {
      return { kind: 'error', errorMessage: 'customer not found' }
    }

    // 4. Confidence gate — classify-if-needed
    let triggerNeed:           string | null = sub.triggerNeed
    let triggerNeedConfidence: 'high' | 'low' | null = (sub.triggerNeedConfidence as 'high' | 'low' | null)

    if (triggerNeedConfidence === null) {
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
        replyText:            sub.replyText,
        billingPortalClicked: !!sub.billingPortalClickedAt,
        cancelledAt:          sub.cancelledAt ?? new Date(),
      }
      const classification = await classifySubscriber(signals, {
        founderName: customer.founderName ?? undefined,
        productName: customer.productName ?? undefined,
      })
      triggerNeed           = classification.triggerNeed
      triggerNeedConfidence = deriveTriggerNeedConfidence(classification)

      await db
        .update(churnedSubscribers)
        .set({
          triggerNeed,
          triggerNeedConfidence,
          cancellationReason:   classification.cancellationReason,
          cancellationCategory: classification.cancellationCategory,
          updatedAt:            new Date(),
        })
        .where(eq(churnedSubscribers.id, sub.id))
    }

    if (triggerNeedConfidence !== 'high' || !triggerNeed) {
      await emitSkipped(sub.id, sub.customerId, 'low_confidence', {
        triggerNeedConfidence,
        hasTriggerNeed: !!triggerNeed,
      })
      return { kind: 'skipped', reason: 'low_confidence' }
    }

    // 5. Active improvements minus already-matched
    const activeImps = await db
      .select()
      .from(improvements)
      .where(and(
        eq(improvements.customerId, customer.id),
        eq(improvements.status, 'published'),
      ))

    if (activeImps.length === 0) {
      await emitSkipped(sub.id, sub.customerId, 'no_improvements', { activeCount: 0 })
      return { kind: 'skipped', reason: 'no_improvements' }
    }

    const matched = await db
      .select({ improvementId: improvementMatches.improvementId })
      .from(improvementMatches)
      .where(eq(improvementMatches.subscriberId, sub.id))
    const alreadyMatchedIds = new Set(matched.map((r) => r.improvementId))

    const candidates: ImprovementForMatcher[] = activeImps
      .filter((i) => !alreadyMatchedIds.has(i.id))
      .map((i) => ({
        id:          i.id,
        title:       i.title,
        description: i.description,
        dateShipped: typeof i.dateShipped === 'string'
          ? i.dateShipped
          : (i.dateShipped as Date).toISOString().slice(0, 10),
      }))

    if (candidates.length === 0) {
      await emitSkipped(sub.id, sub.customerId, 'no_improvements', {
        activeCount: activeImps.length,
        alreadyMatchedCount: alreadyMatchedIds.size,
      })
      return { kind: 'skipped', reason: 'no_improvements' }
    }

    // 6. Best match
    const best = await findBestMatch(triggerNeed, candidates)
    if (!best) {
      await emitSkipped(sub.id, sub.customerId, 'no_match', {
        triggerNeed,
        candidatesCount: candidates.length,
      })
      return { kind: 'skipped', reason: 'no_match' }
    }

    // 7. Generate + sanity check
    const fromName = customer.founderName ?? 'The team'
    const draft = await generateImprovementEmail({
      improvement:    best.improvement,
      triggerNeed,
      subscriberName: sub.name,
      founderName:    fromName,
    })
    if (!draft) {
      return { kind: 'error', errorMessage: 'email generation returned null' }
    }

    const sanity = await sanityCheckEmail({
      triggerNeed,
      improvement: best.improvement,
      email:       draft,
    })

    if (!sanity.pass) {
      await logEvent({
        name:       'email_sanity_check_failed',
        customerId: customer.id,
        properties: {
          subscriberId:           sub.id,
          improvementId:          best.improvement.id,
          improvementTitle:       best.improvement.title,
          improvementDescription: best.improvement.description.slice(0, 200),
          triggerNeed,
          matchConfidence:        best.match.confidence,
          matchReasoning:         best.match.reasoning,
          draftedSubject:         draft.subject,
          draftedBody:            draft.body.slice(0, 500),
          sanityReason:           sanity.reason,
        },
      })
      await emitSkipped(sub.id, sub.customerId, 'sanity_failed', {
        improvementId:    best.improvement.id,
        improvementTitle: best.improvement.title,
        matchConfidence:  best.match.confidence,
        sanityReason:     sanity.reason,
      })
      // Record attempt so we don't retry this improvement.
      await db
        .insert(improvementMatches)
        .values({
          improvementId: best.improvement.id,
          subscriberId:  sub.id,
        })
        .onConflictDoNothing()
      return { kind: 'skipped', reason: 'sanity_failed' }
    }

    // 8. Send + record
    if (!sub.email) {
      return { kind: 'error', errorMessage: 'subscriber has no email' }
    }
    const { messageId } = await sendEmail({
      to:           sub.email,
      subject:      draft.subject,
      body:         draft.body,
      fromName,
      subscriberId: sub.id,
    })

    if (messageId) {
      await db.insert(emailsSent).values({
        subscriberId:   sub.id,
        gmailMessageId: messageId,
        type:           'reengagement',
        subject:        draft.subject,
        improvementId:  best.improvement.id,
      })
    }

    await db.insert(improvementMatches).values({
      improvementId: best.improvement.id,
      subscriberId:  sub.id,
      emailedAt:     new Date(),
    }).onConflictDoNothing()

    await db
      .update(churnedSubscribers)
      .set({
        lastReengagedAt: new Date(),
        status:          'contacted',
        updatedAt:       new Date(),
      })
      .where(eq(churnedSubscribers.id, sub.id))

    await logEvent({
      name:       'reengagement_email_sent',
      customerId: customer.id,
      properties: {
        subscriberId:       sub.id,
        improvementId:      best.improvement.id,
        improvementTitle:   best.improvement.title,
        triggerNeed,
        matchConfidence:    best.match.confidence,
        matchReasoning:     best.match.reasoning,
        subject:            draft.subject,
        improvementAgeDays: Math.floor(
          (Date.now() - new Date(best.improvement.dateShipped + 'T00:00:00Z').getTime()) / (24 * 60 * 60 * 1000),
        ),
      },
    })

    return { kind: 'emailed', improvementId: best.improvement.id }
  } catch (err) {
    console.error('[reengagement-v2] error processing subscriber:', sub.id, err)
    return { kind: 'error', errorMessage: err instanceof Error ? err.message : String(err) }
  }
}

export async function runReengagementCronV2(): Promise<CronV2Stats> {
  const stats: CronV2Stats = {
    considered:             0,
    emailed:                0,
    expired:                0,
    skippedCustomerPaused:  0,
    skippedLowConfidence:   0,
    skippedNoMatch:         0,
    skippedSanity:          0,
    skippedNoImprovements:  0,
    errors:                 0,
  }

  // 1. Expiry sweep
  const expired = await db
    .update(churnedSubscribers)
    .set({
      reengagementExpiredAt: new Date(),
      status:                'lost',
      updatedAt:             new Date(),
    })
    .where(and(
      sql`${churnedSubscribers.cancelledAt} <= now() - interval '9 months'`,
      isNull(churnedSubscribers.reengagementExpiredAt),
      inArray(churnedSubscribers.status, ['pending', 'contacted']),
    ))
    .returning({ id: churnedSubscribers.id })
  stats.expired = expired.length

  // 2. Eligibility query (unchanged — 60-day cooldown enforced at SQL
  //    layer too so we don't even load cooldown'd rows)
  const eligible = await db
    .select()
    .from(churnedSubscribers)
    .where(and(
      inArray(churnedSubscribers.status, ['pending', 'contacted']),
      isNotNull(churnedSubscribers.email),
      eq(churnedSubscribers.doNotContact, false),
      isNull(churnedSubscribers.founderHandoffAt),
      isNull(churnedSubscribers.reengagementExpiredAt),
      sql`${churnedSubscribers.cancelledAt} > now() - interval '9 months'`,
      sql`${churnedSubscribers.cancelledAt} < now() - interval '14 days'`,
      sql`(${churnedSubscribers.lastReengagedAt} IS NULL OR ${churnedSubscribers.lastReengagedAt} < now() - interval '60 days')`,
      sql`(${churnedSubscribers.aiPausedUntil} IS NULL OR ${churnedSubscribers.aiPausedUntil} < now())`,
      sql`(${churnedSubscribers.triggerNeedConfidence} IS NULL OR ${churnedSubscribers.triggerNeedConfidence} = 'high')`,
    ))
    .limit(BATCH_LIMIT)

  stats.considered = eligible.length

  // 3. Process each via the extracted per-subscriber helper.
  for (const sub of eligible) {
    const outcome = await processSubscriberForReengagement(sub)
    switch (outcome.kind) {
      case 'emailed':
        stats.emailed++
        break
      case 'skipped':
        switch (outcome.reason) {
          case 'customer_paused':  stats.skippedCustomerPaused++;  break
          case 'low_confidence':   stats.skippedLowConfidence++;   break
          case 'no_match':         stats.skippedNoMatch++;         break
          case 'sanity_failed':    stats.skippedSanity++;          break
          case 'no_improvements':  stats.skippedNoImprovements++;  break
          // cooldown won't fire from the loop (filtered out in eligibility),
          // expired likewise — kept in the union for the per-subscriber
          // helper's send-now caller.
          default:                                                 break
        }
        break
      case 'error':
        stats.errors++
        break
    }
  }

  return stats
}

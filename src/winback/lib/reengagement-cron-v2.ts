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
 *
 * Differences from V1 (the legacy path):
 * 1. Eligibility-based, NOT one-shot. A subscriber who doesn't match
 *    today stays eligible. No "reengagementCount = 1 set unconditionally"
 *    cliff edge.
 * 2. Classifier confidence gate: subscribers with low trigger_need_confidence
 *    are skipped permanently. Removes the biggest source of bad-match emails.
 * 3. Per-improvement-once-each: wb_improvement_matches composite PK enforces
 *    that a single subscriber hears about a single improvement at most once.
 * 4. Strict matcher confidence threshold (≥ 0.7).
 * 5. Pre-send sanity check on the drafted email — aborts if the LLM
 *    hallucinated.
 * 6. 60-day cooldown between any two changelog-triggered emails to the
 *    same subscriber.
 * 7. 9-month post-cancellation hard wall — subscribers marked `lost`,
 *    permanently exited.
 */

const BATCH_LIMIT = 50

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

  // ============================================================
  // 1. Expiry sweep: subscribers past the 9-month wall → 'lost'
  // ============================================================
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

  // ============================================================
  // 2. Eligibility query
  // ============================================================
  const eligible = await db
    .select()
    .from(churnedSubscribers)
    .where(and(
      inArray(churnedSubscribers.status, ['pending', 'contacted']),
      isNotNull(churnedSubscribers.email),
      eq(churnedSubscribers.doNotContact, false),
      isNull(churnedSubscribers.founderHandoffAt),
      isNull(churnedSubscribers.reengagementExpiredAt),
      // Within the 9-month window
      sql`${churnedSubscribers.cancelledAt} > now() - interval '9 months'`,
      // Past the 14-day cooling-after-cancel window (give exit email a chance)
      sql`${churnedSubscribers.cancelledAt} < now() - interval '14 days'`,
      // Not in 60-day cooldown
      sql`(${churnedSubscribers.lastReengagedAt} IS NULL OR ${churnedSubscribers.lastReengagedAt} < now() - interval '60 days')`,
      // AI pause clear
      sql`(${churnedSubscribers.aiPausedUntil} IS NULL OR ${churnedSubscribers.aiPausedUntil} < now())`,
      // Not yet confirmed low-confidence (or null = not yet decided)
      sql`(${churnedSubscribers.triggerNeedConfidence} IS NULL OR ${churnedSubscribers.triggerNeedConfidence} = 'high')`,
    ))
    .limit(BATCH_LIMIT)

  stats.considered = eligible.length

  for (const sub of eligible) {
    try {
      // ----------------------------------------------------------
      // 3. Customer-level pause checks (win-back cohort, billing pause)
      // ----------------------------------------------------------
      if (await isCustomerPausedForWinback(sub.id))                     { stats.skippedCustomerPaused++; continue }
      if (await isCustomerPausedForBillingByCustomerId(sub.customerId)) { stats.skippedCustomerPaused++; continue }

      // Customer row (for founder name + active improvements)
      const [customer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, sub.customerId))
        .limit(1)
      if (!customer) continue

      // ----------------------------------------------------------
      // 4. Confidence gate — classify-if-needed
      // ----------------------------------------------------------
      let triggerNeed:           string | null = sub.triggerNeed
      let triggerNeedConfidence: 'high' | 'low' | null = (sub.triggerNeedConfidence as 'high' | 'low' | null)

      if (triggerNeedConfidence === null) {
        // First time considering this subscriber. Run classifier to derive.
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

        // Persist the derivation so future cron passes don't re-classify.
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

      if (triggerNeedConfidence !== 'high') {
        stats.skippedLowConfidence++
        continue
      }
      if (!triggerNeed) {
        stats.skippedLowConfidence++
        continue
      }

      // ----------------------------------------------------------
      // 5. Active improvements for this customer, minus already-matched
      // ----------------------------------------------------------
      const activeImps = await db
        .select()
        .from(improvements)
        .where(and(
          eq(improvements.customerId, customer.id),
          eq(improvements.status, 'published'),
        ))

      if (activeImps.length === 0) {
        stats.skippedNoImprovements++
        continue
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
        stats.skippedNoImprovements++
        continue
      }

      // ----------------------------------------------------------
      // 6. Best match (confidence ≥ 0.7)
      // ----------------------------------------------------------
      const best = await findBestMatch(triggerNeed, candidates)
      if (!best) {
        stats.skippedNoMatch++
        continue
      }

      // ----------------------------------------------------------
      // 7. Generate email + sanity check
      // ----------------------------------------------------------
      const fromName = customer.founderName ?? 'The team'
      const draft = await generateImprovementEmail({
        improvement:    best.improvement,
        triggerNeed,
        subscriberName: sub.name,
        founderName:    fromName,
      })
      if (!draft) { stats.errors++; continue }

      const sanity = await sanityCheckEmail({
        triggerNeed,
        improvement: best.improvement,
        email:       draft,
      })

      if (!sanity.pass) {
        stats.skippedSanity++
        await logEvent({
          name:       'email_sanity_check_failed',
          customerId: customer.id,
          properties: {
            subscriberId:  sub.id,
            improvementId: best.improvement.id,
            reason:        sanity.reason,
            confidence:    best.match.confidence,
          },
        })
        // Record the match attempt without an emailed_at — so we know we
        // tried this improvement for this subscriber and won't re-try.
        await db
          .insert(improvementMatches)
          .values({
            improvementId: best.improvement.id,
            subscriberId:  sub.id,
          })
          .onConflictDoNothing()
        continue
      }

      // ----------------------------------------------------------
      // 8. Send + record
      // ----------------------------------------------------------
      if (!sub.email) { stats.errors++; continue }
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

      stats.emailed++

      await logEvent({
        name:       'reengagement_email_sent',
        customerId: customer.id,
        properties: {
          subscriberId:    sub.id,
          improvementId:   best.improvement.id,
          matchConfidence: best.match.confidence,
          improvementAgeDays: Math.floor(
            (Date.now() - new Date(best.improvement.dateShipped + 'T00:00:00Z').getTime()) / (24 * 60 * 60 * 1000),
          ),
        },
      })
    } catch (err) {
      console.error('[reengagement-v2] error processing subscriber:', sub.id, err)
      stats.errors++
    }
  }

  return stats
}

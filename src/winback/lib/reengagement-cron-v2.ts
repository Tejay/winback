import { db } from '@/lib/db'
import {
  churnedSubscribers,
  customers,
  emailsSent,
  improvements,
  improvementMatches,
} from '@/lib/schema'
import { and, eq, inArray, isNull, isNotNull, sql } from 'drizzle-orm'
import {
  sendEmail,
  isCustomerPausedForWinback,
  isCustomerPausedForBillingByCustomerId,
} from './email'
import {
  deriveTriggerNeedConfidence,
  findBestMatch,
  generateImprovementEmail,
  generatePromotionEmail,
  sanityCheckEmail,
  sanityCheckPromotionEmail,
  type ImprovementForMatcher,
} from './improvement-match'
import {
  findBestPromotionForSubscriber,
  parsePromotionRows,
  summarizePromotion,
  type PromotionRow,
} from './promotion-match'
import { logEvent } from './events'
import type { ClassificationResult } from './types'

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
 * Spec 78 — promotion fallback path.
 *
 * Called from each fall-through point in processSubscriberForReengagement
 * (low confidence, no improvements available, no LLM match). Returns
 * 'emailed' if a promo email was sent, null if the subscriber/merchant
 * isn't eligible for a promo (so the caller falls back to the original
 * skip-reason emit).
 *
 * Gates here are mostly redundant with findBestPromotionForSubscriber's
 * own eligibility checks, but we check customer.promotionsEnabled +
 * cancellationCategory='Price' + tier=1 first to avoid the DB query
 * + Stripe round-trip for the common case of an ineligible subscriber.
 */
type CustomerRow = typeof customers.$inferSelect
async function tryPromotionPath(
  sub: SubRow,
  customer: CustomerRow,
): Promise<PerSubscriberOutcome | null> {
  if (!customer.promotionsEnabled) return null
  if (sub.tier !== 1) return null
  if (sub.cancellationCategory !== 'Price') return null

  // Load active kind='promotion' rows for this customer
  const rawRows = await db
    .select({
      id:                improvements.id,
      promotionMetadata: improvements.promotionMetadata,
      createdAt:         improvements.createdAt,
    })
    .from(improvements)
    .where(and(
      eq(improvements.customerId, customer.id),
      eq(improvements.kind, 'promotion'),
      eq(improvements.status, 'published'),
    ))

  // Cast row.createdAt to Date (drizzle returns Date for withTimezone:true)
  const promos: PromotionRow[] = parsePromotionRows(
    rawRows.map((r) => ({
      id: r.id,
      promotionMetadata: r.promotionMetadata,
      createdAt: r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt as unknown as string),
    })),
  )

  const best = findBestPromotionForSubscriber(
    { tier: sub.tier, cancellationCategory: sub.cancellationCategory, mrrCents: sub.mrrCents, stripePriceId: sub.stripePriceId },
    promos,
    customer.promotionsEnabled,
  )
  if (!best) return null

  // Already matched on this improvement? (re-using improvementMatches
  // table as the "this subscriber already heard about this promo" dedup
  // ledger — same primary key shape works.)
  const [prev] = await db
    .select({ subscriberId: improvementMatches.subscriberId })
    .from(improvementMatches)
    .where(and(
      eq(improvementMatches.improvementId, best.id),
      eq(improvementMatches.subscriberId, sub.id),
    ))
    .limit(1)
  if (prev) return null

  const fromName = customer.founderName ?? 'The team'
  const draft = await generatePromotionEmail({
    promotion:      best.promotionMetadata,
    triggerNeed:    sub.triggerNeed,
    subscriberName: sub.name,
    founderName:    fromName,
  })
  if (!draft) return { kind: 'error', errorMessage: 'promotion email generation returned null' }

  const sanity = await sanityCheckPromotionEmail({
    promotion:   best.promotionMetadata,
    triggerNeed: sub.triggerNeed,
    email:       draft,
  })
  if (!sanity.pass) {
    await logEvent({
      name: 'promotion_email_sanity_failed',
      customerId: customer.id,
      properties: {
        subscriberId:     sub.id,
        improvementId:    best.id,
        promotionCode:    best.promotionMetadata.code,
        draftedSubject:   draft.subject,
        draftedBody:      draft.body.slice(0, 500),
        sanityReason:     sanity.reason,
      },
    })
    await emitSkipped(sub.id, sub.customerId, 'sanity_failed', {
      improvementId: best.id,
      promotionCode: best.promotionMetadata.code,
      sanityReason:  sanity.reason,
    })
    // Record attempt so we don't re-burn LLM cost on the same row.
    await db
      .insert(improvementMatches)
      .values({ improvementId: best.id, subscriberId: sub.id })
      .onConflictDoNothing()
    return { kind: 'skipped', reason: 'sanity_failed' }
  }

  if (!sub.email) return { kind: 'error', errorMessage: 'subscriber has no email' }
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
      improvementId:  best.id,
    })
  }

  await db.insert(improvementMatches).values({
    improvementId: best.id,
    subscriberId:  sub.id,
    emailedAt:     new Date(),
  }).onConflictDoNothing()

  await db
    .update(churnedSubscribers)
    .set({ lastReengagedAt: new Date(), status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, sub.id))

  await logEvent({
    name: 'reengagement_email_sent',
    customerId: customer.id,
    properties: {
      subscriberId:   sub.id,
      improvementId:  best.id,
      kind:           'promotion',
      promotionCode:  best.promotionMetadata.code,
      promotionTerms: summarizePromotion(best),
      subject:        draft.subject,
    },
  })

  return { kind: 'emailed', improvementId: best.id }
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

    // 4. Confidence gate.
    //
    // Spec 72 — classifier-tick now derives + persists
    // triggerNeedConfidence at initial classification (for signal-bearing
    // rows). Silent-churn rows reach V2 with confidence = NULL because
    // we had nothing to judge from. For those, derive from the existing
    // stored fields (no LLM call — they were already classified by
    // classifier-tick). The old "first-visit re-classify" branch is
    // gone; that was a $0.003 leak per silent-churn row.
    let triggerNeed:           string | null = sub.triggerNeed
    let triggerNeedConfidence: 'high' | 'low' | null = (sub.triggerNeedConfidence as 'high' | 'low' | null)

    if (triggerNeedConfidence === null) {
      // Derive from what's already on the row. classifier-tick populated
      // tier / confidence / cancellationCategory / triggerNeed for every
      // row; silent-churn rows just got the deterministic fallback shape.
      triggerNeedConfidence = deriveTriggerNeedConfidence({
        triggerNeed:          sub.triggerNeed,
        cancellationCategory: sub.cancellationCategory,
        confidence:           sub.confidence !== null ? Number(sub.confidence) : 0,
      } as ClassificationResult)

      await db
        .update(churnedSubscribers)
        .set({ triggerNeedConfidence, updatedAt: new Date() })
        .where(eq(churnedSubscribers.id, sub.id))
    }

    if (triggerNeedConfidence !== 'high' || !triggerNeed) {
      // Spec 78 — even for low-confidence triggerNeed, a Price-category
      // Tier-1 subscriber whose merchant has opted into promotions is
      // still eligible for a promo email. Try that path before declaring
      // a skip.
      const promoOutcome = await tryPromotionPath(sub, customer)
      if (promoOutcome) return promoOutcome
      await emitSkipped(sub.id, sub.customerId, 'low_confidence', {
        triggerNeedConfidence,
        hasTriggerNeed: !!triggerNeed,
      })
      return { kind: 'skipped', reason: 'low_confidence' }
    }

    // 5. Active improvements minus already-matched. Filter to kind='product'
    // — promotion-kind rows live in the same table but never go through the
    // LLM matcher (their selection is deterministic, handled in step 6b).
    const activeImps = await db
      .select()
      .from(improvements)
      .where(and(
        eq(improvements.customerId, customer.id),
        eq(improvements.status, 'published'),
        eq(improvements.kind, 'product'),
      ))

    if (activeImps.length === 0) {
      // Spec 78 — no shipped improvements to match. If this is a Price
      // cancel with promotions enabled, fall through to the promo path
      // before skipping.
      const promoOutcome = await tryPromotionPath(sub, customer)
      if (promoOutcome) return promoOutcome
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
      // Spec 78 — exhausted product-improvement matches. Fall through to
      // promo path if eligible.
      const promoOutcome = await tryPromotionPath(sub, customer)
      if (promoOutcome) return promoOutcome
      await emitSkipped(sub.id, sub.customerId, 'no_improvements', {
        activeCount: activeImps.length,
        alreadyMatchedCount: alreadyMatchedIds.size,
      })
      return { kind: 'skipped', reason: 'no_improvements' }
    }

    // 6. Best match
    const best = await findBestMatch(triggerNeed, candidates)
    if (!best) {
      // Spec 78 — LLM found no product-improvement that matches. Fall
      // through to promo path if eligible.
      const promoOutcome = await tryPromotionPath(sub, customer)
      if (promoOutcome) return promoOutcome
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

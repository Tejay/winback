import { z } from 'zod'
import type { WbPromotionMetadata } from './promotions'
import { WbPromotionMetadataSchema, formatPromotionTerms } from './promotions'

/**
 * Spec 78 followup — single-selected-promotion gate.
 *
 * The merchant picks one promo from the synced list on /reasons. The
 * re-engagement path either uses that promo (when the four bulletproof
 * gates pass for this specific subscriber) or sends a no-promo email.
 *
 * Selection is no longer a tiebreak — there's only one candidate. Anything
 * Stripe will evaluate at redemption that we *don't* check below
 * (first_time_transaction, minimum_amount, customer pin, currency mismatch
 * on amount-off coupons, plus future restriction fields) is the merchant's
 * responsibility — surfaced in the /reasons UI before they pick.
 *
 * Eligibility (all must be true):
 *   - promotionsEnabled = true
 *   - subscriber.tier = 1
 *   - subscriber.cancellationCategory = 'Price'
 *   - promo.active = true
 *   - promo.redeemBy is null OR > now
 *   - promo.timesRedeemed < (promo.maxRedemptions ?? Infinity)
 *   - promo.appliesToPriceIds is empty (= all) OR contains subscriber.stripePriceId
 */

export interface PromotionSubscriberSignals {
  tier: number | null
  cancellationCategory: string | null
  mrrCents: number
  stripePriceId: string | null
}

export interface PromotionRow {
  id: string                                  // wb_improvements.id
  promotionMetadata: WbPromotionMetadata
  createdAt: Date
}

const PromotionRowSchema = z.object({
  id: z.string(),
  promotionMetadata: WbPromotionMetadataSchema,
  createdAt: z.date(),
})

/**
 * Parses raw DB rows (with jsonb promotion_metadata) into typed
 * PromotionRow objects. Skips rows whose metadata fails validation
 * (defensive — stale schema, manual edits, etc.).
 */
export function parsePromotionRows(
  rows: Array<{ id: string; promotionMetadata: unknown; createdAt: Date }>,
): PromotionRow[] {
  const out: PromotionRow[] = []
  for (const row of rows) {
    const parsed = PromotionRowSchema.safeParse(row)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/**
 * Returns the selected promo if it passes the bulletproof gates for this
 * subscriber, otherwise null. Caller falls back to no-promo email path.
 *
 * `selected` may be null when the merchant hasn't picked anything yet —
 * we short-circuit in that case so the caller doesn't have to.
 */
export function getApplicablePromotionForSubscriber(
  sub: PromotionSubscriberSignals,
  selected: PromotionRow | null,
  promotionsEnabled: boolean,
  now: Date = new Date(),
): PromotionRow | null {
  if (!promotionsEnabled) return null
  if (!selected) return null
  if (sub.tier !== 1) return null
  if (sub.cancellationCategory !== 'Price') return null

  const m = selected.promotionMetadata
  if (!m.active) return null
  if (m.redeemBy) {
    const expiresAt = new Date(m.redeemBy)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= now) return null
  }
  if (m.maxRedemptions !== null && m.timesRedeemed >= m.maxRedemptions) return null
  if (m.appliesToPriceIds.length > 0) {
    if (!sub.stripePriceId) return null
    if (!m.appliesToPriceIds.includes(sub.stripePriceId)) return null
  }
  return selected
}

/**
 * Human-readable terms string for emit-event payloads + audit logs.
 * (UI uses formatPromotionTerms/formatPromotionChip from promotions.ts
 * directly.)
 */
export function summarizePromotion(promo: PromotionRow): string {
  return `${promo.promotionMetadata.code} — ${formatPromotionTerms(promo.promotionMetadata)}`
}

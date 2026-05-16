import { z } from 'zod'
import type { WbPromotionMetadata } from './promotions'
import { WbPromotionMetadataSchema, formatPromotionTerms } from './promotions'

/**
 * Spec 78 — deterministic promotion selection.
 *
 * Pure code, no LLM. Given:
 *   • a subscriber (tier, cancellationCategory, mrrCents, stripePriceId)
 *   • the merchant's promotionsEnabled flag
 *   • a list of kind='promotion' improvement rows for that merchant
 *
 * Returns the single best applicable promotion, or null. The LLM's role
 * is upstream (classifier produces Price category + tier) and downstream
 * (email composer renders the chosen promo). Selection itself is
 * predictable so merchants can reason about which promo will be used
 * by adjusting Stripe-side primitives (appliesToPriceIds, redeemBy,
 * maxRedemptions).
 *
 * Eligibility gate (all must be true):
 *   - promotionsEnabled = true
 *   - subscriber.tier = 1
 *   - subscriber.cancellationCategory = 'Price'
 *   - promo.active = true
 *   - promo.redeemBy is null OR > now
 *   - promo.timesRedeemed < (promo.maxRedemptions ?? Infinity)
 *   - promo.appliesToPriceIds is empty (= all) OR contains subscriber.stripePriceId
 *
 * Tiebreak:
 *   1. max(percentOff/100 × subscriber.mrrCents, amountOffCents)
 *   2. soonest redeemBy
 *   3. newest createdAt (use improvement row's createdAt)
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
  createdAt: Date                             // for the newest-wins tiebreak
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

function isEligible(
  promo: PromotionRow,
  sub: PromotionSubscriberSignals,
  promotionsEnabled: boolean,
  now: Date = new Date(),
): boolean {
  if (!promotionsEnabled) return false
  if (sub.tier !== 1) return false
  if (sub.cancellationCategory !== 'Price') return false

  const m = promo.promotionMetadata
  if (!m.active) return false
  if (m.redeemBy) {
    const expiresAt = new Date(m.redeemBy)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= now) return false
  }
  if (m.maxRedemptions !== null && m.timesRedeemed >= m.maxRedemptions) return false
  if (m.appliesToPriceIds.length > 0) {
    if (!sub.stripePriceId) return false
    if (!m.appliesToPriceIds.includes(sub.stripePriceId)) return false
  }
  return true
}

function discountValueCents(promo: PromotionRow, sub: PromotionSubscriberSignals): number {
  const m = promo.promotionMetadata
  if (m.percentOff !== null) {
    return Math.round((m.percentOff / 100) * sub.mrrCents)
  }
  if (m.amountOffCents !== null) {
    return m.amountOffCents
  }
  return 0
}

export function findBestPromotionForSubscriber(
  sub: PromotionSubscriberSignals,
  promos: PromotionRow[],
  promotionsEnabled: boolean,
  now: Date = new Date(),
): PromotionRow | null {
  const eligible = promos.filter((p) => isEligible(p, sub, promotionsEnabled, now))
  if (eligible.length === 0) return null

  eligible.sort((a, b) => {
    // 1. Highest discount value (descending)
    const va = discountValueCents(a, sub)
    const vb = discountValueCents(b, sub)
    if (va !== vb) return vb - va
    // 2. Soonest redeemBy (nulls last)
    const ra = a.promotionMetadata.redeemBy ? new Date(a.promotionMetadata.redeemBy).getTime() : Infinity
    const rb = b.promotionMetadata.redeemBy ? new Date(b.promotionMetadata.redeemBy).getTime() : Infinity
    if (ra !== rb) return ra - rb
    // 3. Newest createdAt (descending)
    return b.createdAt.getTime() - a.createdAt.getTime()
  })

  return eligible[0]
}

/**
 * Human-readable terms string for emit-event payloads + audit logs.
 * (UI uses formatPromotionTerms/formatPromotionChip from promotions.ts
 * directly.)
 */
export function summarizePromotion(promo: PromotionRow): string {
  return `${promo.promotionMetadata.code} — ${formatPromotionTerms(promo.promotionMetadata)}`
}

import type Stripe from 'stripe'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { customers, emailsSent, improvements } from '@/lib/schema'
import { getConnectStripe } from './stripe'
import { decrypt } from './encryption'
import { logEvent } from './events'

/**
 * Spec 78 — Stripe-native promotions ingestion.
 *
 * Promotions live in Stripe (merchants author them there). We mirror them
 * into `wb_improvements` rows with `kind='promotion'` so the matcher,
 * dashboard and reasons UI can read them through a single primitive.
 * Winback never writes back to Stripe — no coupons.create, no
 * promotionCodes.create. Editing is in Stripe Dashboard; we resync.
 *
 * Coupons that have no associated promotion code are ignored — the email
 * needs a customer-facing redeemable string, and raw `coupon.id` isn't
 * one.
 */

// --------------------------------------------------------------------------
// Stored shape — what we persist in improvements.promotion_metadata
// --------------------------------------------------------------------------
export const WbPromotionMetadataSchema = z.object({
  stripeCouponId:        z.string(),
  stripePromotionCodeId: z.string(),
  code:                  z.string(),
  name:                  z.string().nullable(),
  percentOff:            z.number().nullable(),
  amountOffCents:        z.number().int().nullable(),
  currency:              z.string().nullable(),
  duration:              z.enum(['once', 'repeating', 'forever']),
  durationInMonths:      z.number().int().nullable(),
  redeemBy:              z.string().nullable(),  // ISO datetime
  // Pre-expanded at sync time from coupon.applies_to.products: we fetch
  // each product's active prices and store the price ids. Empty array =
  // applies to all prices. If the merchant later adds a price to an
  // already-eligible product, the matcher won't pick it up until the
  // next /api/promotions/refresh.
  appliesToPriceIds:     z.array(z.string()),
  maxRedemptions:        z.number().int().nullable(),
  timesRedeemed:         z.number().int(),
  active:                z.boolean(),
  syncedAt:              z.string(),
})

export type WbPromotionMetadata = z.infer<typeof WbPromotionMetadataSchema>

// --------------------------------------------------------------------------
// Build metadata from Stripe payload
// --------------------------------------------------------------------------
async function expandAppliesToPriceIds(
  stripe: Stripe,
  productIds: string[] | undefined,
): Promise<string[]> {
  if (!productIds || productIds.length === 0) return []
  const out: string[] = []
  for (const productId of productIds) {
    try {
      // Stripe paginates prices; for v1 we cap at 100 active prices per
      // product (the default page). Merchants with >100 active prices on a
      // single product are out-of-scope for v1.
      const prices = await stripe.prices.list({ product: productId, active: true, limit: 100 })
      for (const p of prices.data) out.push(p.id)
    } catch (err) {
      console.error('[promotions] prices.list failed for product', productId, err)
    }
  }
  return out
}

export async function buildPromotionMetadata(
  stripe: Stripe,
  promo: Stripe.PromotionCode,
): Promise<WbPromotionMetadata> {
  // Stripe API ≥ 2026-03-25.dahlia moved `promo.coupon` to
  // `promo.promotion.coupon`. CLAUDE.md pins us to that version, so the
  // new shape is canonical. If the embedded coupon arrived as a string
  // id (event payload may not auto-expand), fetch the coupon directly.
  const couponField = promo.promotion?.coupon
  if (!couponField) {
    throw new Error(`promotion code ${promo.id} has no coupon attached`)
  }
  const coupon: Stripe.Coupon = typeof couponField === 'string'
    ? await stripe.coupons.retrieve(couponField)
    : couponField

  const productIds = (coupon.applies_to?.products as string[] | undefined) ?? []
  const priceIds = await expandAppliesToPriceIds(stripe, productIds)

  return {
    stripeCouponId:        coupon.id,
    stripePromotionCodeId: promo.id,
    code:                  promo.code,
    name:                  coupon.name ?? null,
    percentOff:            coupon.percent_off ?? null,
    amountOffCents:        coupon.amount_off ?? null,
    currency:              coupon.currency ?? null,
    duration:              coupon.duration as 'once' | 'repeating' | 'forever',
    durationInMonths:      coupon.duration_in_months ?? null,
    redeemBy: coupon.redeem_by
      ? new Date(coupon.redeem_by * 1000).toISOString()
      : promo.expires_at
        ? new Date(promo.expires_at * 1000).toISOString()
        : null,
    appliesToPriceIds:     priceIds,
    maxRedemptions:        promo.max_redemptions ?? coupon.max_redemptions ?? null,
    timesRedeemed:         promo.times_redeemed ?? 0,
    // Stripe says "active" on the promotion code; coupon.valid also matters
    // (a coupon can be expired/used-up while its promotion code is "active").
    active:                Boolean(promo.active) && Boolean(coupon.valid),
    syncedAt:              new Date().toISOString(),
  }
}

// --------------------------------------------------------------------------
// Display helpers — used by /reasons UI + dashboard chip
// --------------------------------------------------------------------------
export function formatPromotionTerms(p: WbPromotionMetadata): string {
  const discount = p.percentOff !== null
    ? `${p.percentOff}% off`
    : p.amountOffCents !== null && p.currency
      ? `${(p.amountOffCents / 100).toFixed(2)} ${p.currency.toUpperCase()} off`
      : 'discount'
  const duration = p.duration === 'forever'
    ? 'forever'
    : p.duration === 'once'
      ? 'once'
      : p.durationInMonths
        ? `${p.durationInMonths} months`
        : 'recurring'
  return `${discount} · ${duration}`
}

export function formatPromotionChip(p: WbPromotionMetadata): string {
  const sign = p.percentOff !== null
    ? `-${p.percentOff}%`
    : p.amountOffCents !== null && p.currency
      ? `-${(p.amountOffCents / 100).toFixed(0)} ${p.currency.toUpperCase()}`
      : '-discount'
  const dur = p.duration === 'once'
    ? '× 1mo'
    : p.duration === 'forever'
      ? '· forever'
      : p.durationInMonths
        ? `× ${p.durationInMonths}mo`
        : ''
  return `${p.code} · ${sign} ${dur}`.trim()
}

// --------------------------------------------------------------------------
// Persistence — upsert + archive
// --------------------------------------------------------------------------
/**
 * Upserts a `kind='promotion'` row into `wb_improvements` for the given
 * customer + promotion code. Updates the metadata + status on every call.
 *
 * Idempotent: keyed on (customer_id, promotion_metadata->>'stripePromotionCodeId').
 * Drizzle doesn't expose the JSON-path index pattern cleanly, so we read
 * existing rows and decide insert vs update in app code.
 */
export async function upsertPromotionImprovement(
  customerId: string,
  metadata: WbPromotionMetadata,
): Promise<{ created: boolean; archivedExisting: boolean }> {
  // Drizzle's jsonb path filtering is awkward — do the match in JS by
  // pulling the metadata for this customer's promotion rows. Small set
  // (a single merchant rarely has >50 active promos).
  const candidates = await db
    .select({
      id: improvements.id,
      status: improvements.status,
      promotionMetadata: improvements.promotionMetadata,
    })
    .from(improvements)
    .where(and(
      eq(improvements.customerId, customerId),
      eq(improvements.kind, 'promotion'),
    ))

  const match = candidates.find((c) => {
    const meta = c.promotionMetadata as { stripePromotionCodeId?: string } | null
    return meta?.stripePromotionCodeId === metadata.stripePromotionCodeId
  })

  if (match) {
    await db
      .update(improvements)
      .set({
        promotionMetadata: metadata as unknown as Record<string, unknown>,
        // Re-publish if the promo became active again after being archived.
        status: metadata.active ? 'published' : 'archived',
        archivedAt: metadata.active ? null : (match.status === 'archived' ? new Date() : new Date()),
        updatedAt: new Date(),
        // title/description rendered from metadata at read time, but keep
        // these columns populated so older code paths (matcher's
        // ImprovementForMatcher shape) don't fall over on NULL.
        title: `${metadata.code} — ${formatPromotionTerms(metadata)}`,
        description: metadata.name ?? `Stripe promotion code ${metadata.code}`,
      })
      .where(eq(improvements.id, match.id))
    return { created: false, archivedExisting: false }
  }

  await db.insert(improvements).values({
    customerId,
    kind: 'promotion',
    promotionMetadata: metadata as unknown as Record<string, unknown>,
    title: `${metadata.code} — ${formatPromotionTerms(metadata)}`,
    description: metadata.name ?? `Stripe promotion code ${metadata.code}`,
    dateShipped: new Date().toISOString().slice(0, 10),
    status: metadata.active ? 'published' : 'archived',
    addressesPattern: null,
    preempted: false,
    archivedAt: metadata.active ? null : new Date(),
  })

  return { created: true, archivedExisting: false }
}

/**
 * Marks a promotion as archived (the coupon was deleted or the promotion
 * code deactivated in Stripe). Idempotent.
 */
export async function archivePromotionImprovement(
  customerId: string,
  stripePromotionCodeId: string,
): Promise<{ archived: boolean }> {
  const candidates = await db
    .select({
      id: improvements.id,
      status: improvements.status,
      promotionMetadata: improvements.promotionMetadata,
    })
    .from(improvements)
    .where(and(
      eq(improvements.customerId, customerId),
      eq(improvements.kind, 'promotion'),
    ))

  const match = candidates.find((c) => {
    const meta = c.promotionMetadata as { stripePromotionCodeId?: string } | null
    return meta?.stripePromotionCodeId === stripePromotionCodeId
  })

  if (!match) return { archived: false }
  if (match.status === 'archived') return { archived: false }

  await db
    .update(improvements)
    .set({
      status: 'archived',
      archivedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(improvements.id, match.id))

  return { archived: true }
}

/**
 * Re-pulls all active promotion codes from the merchant's Stripe account.
 * Used by the "Refresh from Stripe" button on /reasons and as a self-heal
 * when webhook delivery has been delayed or missed entirely.
 */
export async function syncActivePromotionsFromStripe(
  customerId: string,
): Promise<{ synced: number; archived: number }> {
  const [cust] = await db
    .select({
      stripeAccessToken: customers.stripeAccessToken,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)
  if (!cust?.stripeAccessToken) {
    throw new Error(`customer ${customerId} has no Stripe access token`)
  }

  const stripe = getConnectStripe(decrypt(cust.stripeAccessToken))

  // Pull active promotion codes (with coupon expanded). Limit at 100 for v1.
  const promos = await stripe.promotionCodes.list({ active: true, limit: 100 })

  let syncedCount = 0
  const seenStripePromoIds = new Set<string>()

  for (const promo of promos.data) {
    try {
      const metadata = await buildPromotionMetadata(stripe, promo)
      await upsertPromotionImprovement(customerId, metadata)
      seenStripePromoIds.add(promo.id)
      syncedCount++
    } catch (err) {
      console.error('[promotions] sync failed for', promo.id, err)
    }
  }

  // Any previously-published promo that's no longer in the active list
  // (deleted, deactivated, used up) gets archived.
  const existing = await db
    .select({
      id: improvements.id,
      status: improvements.status,
      promotionMetadata: improvements.promotionMetadata,
    })
    .from(improvements)
    .where(and(
      eq(improvements.customerId, customerId),
      eq(improvements.kind, 'promotion'),
      eq(improvements.status, 'published'),
    ))

  let archivedCount = 0
  for (const row of existing) {
    const meta = row.promotionMetadata as { stripePromotionCodeId?: string } | null
    if (!meta?.stripePromotionCodeId) continue
    if (seenStripePromoIds.has(meta.stripePromotionCodeId)) continue
    await db
      .update(improvements)
      .set({ status: 'archived', archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(improvements.id, row.id))
    archivedCount++
  }

  logEvent({
    name: 'promotions_synced',
    customerId,
    properties: { syncedCount, archivedCount },
  })

  return { synced: syncedCount, archived: archivedCount }
}

/**
 * Looks up the most recent re-engagement email sent to this subscriber.
 * If it was a promotion email AND the underlying promotion is still
 * valid (active, not expired, not max-redeemed), returns the metadata.
 * Returns null otherwise — caller activates without discount.
 *
 * Used by the reactivation flow to decide whether to attach a promotion
 * code to the resumed/new Stripe subscription.
 */
export async function loadAppliedPromotionForSubscriber(
  subscriberId: string,
): Promise<WbPromotionMetadata | null> {
  const [latest] = await db
    .select({ improvementId: emailsSent.improvementId })
    .from(emailsSent)
    .where(and(
      eq(emailsSent.subscriberId, subscriberId),
      eq(emailsSent.type, 'reengagement'),
    ))
    .orderBy(desc(emailsSent.sentAt))
    .limit(1)
  if (!latest?.improvementId) return null

  const [imp] = await db
    .select({
      kind:     improvements.kind,
      metadata: improvements.promotionMetadata,
    })
    .from(improvements)
    .where(eq(improvements.id, latest.improvementId))
    .limit(1)
  if (!imp || imp.kind !== 'promotion') return null

  const parsed = WbPromotionMetadataSchema.safeParse(imp.metadata)
  if (!parsed.success) return null

  // Re-check validity at click time — promotion might have expired or
  // been exhausted between email send and click.
  const promo = parsed.data
  if (!promo.active) return null
  if (promo.redeemBy) {
    const expiresAt = new Date(promo.redeemBy)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= new Date()) return null
  }
  if (promo.maxRedemptions !== null && promo.timesRedeemed >= promo.maxRedemptions) {
    return null
  }

  return promo
}

import type Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq, and, isNull, or, lt } from 'drizzle-orm'
import { getPlatformStripe } from './platform-stripe'
import { getOrCreatePlatformCustomer } from './platform-billing'
import { getCustomMonthlyCents } from './flat-rate'
import { logEvent } from './events'
import { tierPriceId, tierFromPriceId, type TierKey } from './tiers'

/**
 * Stripe Subscription primitives for the tiered platform fee.
 *
 * The platform fee is delivered as a recurring Stripe Subscription on
 * Winback's own Stripe account (not the merchant's connected account).
 * Stripe handles billing cycles, proration on tier changes, dunning, and
 * payment retries.
 *
 * Activation timing is owned by activation.ts. This file is only called by
 * activation.ts (and tests).
 *
 * Carve-outs that override the tier-derived price:
 *   - customMonthlyCents (negotiated flat-rate) → one-off Price at the
 *     custom amount, no tier Price used.
 *   - enterprise tier → never auto-charged. ensurePlatformSubscription
 *     throws if asked to subscribe an enterprise account.
 */

export const PLATFORM_FEE_CURRENCY = 'usd'

export type SubscriptionStatus =
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'trialing'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused'
  | null

// TTL on the creation lock. A claim older than this (i.e., a crashed
// claimer) can be reclaimed by the next caller. 30s comfortably covers a
// stripe.subscriptions.create call plus the subsequent UPDATE.
const SUBSCRIPTION_CREATION_LOCK_TTL_MS = 30_000

// Race-loser polling. The loser polls every POLL_INTERVAL_MS for up to
// TOTAL_WAIT_MS, returning as soon as the winner writes
// stripe_subscription_id. Falls through to the same throw if the total
// window expires.
const SUBSCRIPTION_CREATION_RACE_POLL_INTERVAL_MS = 500
const SUBSCRIPTION_CREATION_RACE_TOTAL_WAIT_MS = 10_000

/**
 * Idempotent. Returns the existing Stripe Subscription ID for this
 * customer if one is already active; otherwise creates a new subscription
 * on the supplied tier's Price (or the customer's recommended_tier if
 * `tier` is omitted).
 *
 * Caller responsibility: payment method must already be on file. This
 * function does not check for a card; Stripe will refuse to create the
 * subscription if there's no default PM. Treat the throw as expected if
 * you call this without verifying card presence first.
 *
 * Tier resolution priority:
 *   1. Explicit `tier` arg (passed by commitActivation after the customer
 *      confirms on the activation page).
 *   2. customers.recommendedTier (set by the snapshot cron or
 *      prepareActivation).
 *   3. Throw — refusing to silently pick a tier prevents accidental
 *      under/over-charging.
 *
 * Carve-outs override the tier resolution:
 *   - customMonthlyCents set → ignores tier, uses a one-off custom Price.
 *   - tier resolves to 'enterprise' → throws; sales handles this.
 */
export async function ensurePlatformSubscription(
  wbCustomerId: string,
  tier?: TierKey,
): Promise<{ subscriptionId: string; created: boolean }> {
  const [row] = await db
    .select({
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
      stripeSubscriptionId: customers.stripeSubscriptionId,
      recommendedTier: customers.recommendedTier,
    })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  if (!row) throw new Error(`wb_customer ${wbCustomerId} not found`)

  // Resolve the tier we're going to bill on, before doing any work.
  // Custom flat-rate skips this entirely.
  const flatRateCents = await getCustomMonthlyCents(wbCustomerId)
  let resolvedTier: TierKey | null = null
  if (flatRateCents === null) {
    const candidate = tier ?? (row.recommendedTier as TierKey | null)
    if (!candidate) {
      throw new Error(
        `ensurePlatformSubscription: no tier specified and recommended_tier is null for ${wbCustomerId}`,
      )
    }
    if (candidate === 'enterprise') {
      throw new Error(
        `ensurePlatformSubscription: enterprise tier is sales-handled — refuse to auto-charge for ${wbCustomerId}`,
      )
    }
    resolvedTier = candidate
  }

  if (row.stripeSubscriptionId) {
    // Verify the cached subscription is not in a terminal state. If it is,
    // we'll create a new one (e.g. customer cancelled and is reactivating).
    const stripe = getPlatformStripe()
    try {
      const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId)
      if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
        return { subscriptionId: sub.id, created: false }
      }
    } catch {
      // Cached ID is stale (deleted in Stripe); fall through to create.
    }
  }

  // Race fence: two callers (e.g., the activate endpoint and a
  // checkout.session.completed webhook) can reach here in parallel.
  // The conditional UPDATE is atomic — only one caller's .returning() is
  // non-empty.
  const claimedAt = new Date()
  const claimStaleCutoff = new Date(
    claimedAt.getTime() - SUBSCRIPTION_CREATION_LOCK_TTL_MS,
  )
  const claimed = await db
    .update(customers)
    .set({ stripeSubscriptionCreatingAt: claimedAt, updatedAt: claimedAt })
    .where(
      and(
        eq(customers.id, wbCustomerId),
        isNull(customers.stripeSubscriptionId),
        or(
          isNull(customers.stripeSubscriptionCreatingAt),
          lt(customers.stripeSubscriptionCreatingAt, claimStaleCutoff),
        ),
      ),
    )
    .returning({ id: customers.id })

  if (claimed.length === 0) {
    // Lost the race. Poll for the winner to write the sub id.
    const deadline = Date.now() + SUBSCRIPTION_CREATION_RACE_TOTAL_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, SUBSCRIPTION_CREATION_RACE_POLL_INTERVAL_MS),
      )
      const [after] = await db
        .select({ stripeSubscriptionId: customers.stripeSubscriptionId })
        .from(customers)
        .where(eq(customers.id, wbCustomerId))
        .limit(1)
      if (after?.stripeSubscriptionId) {
        return { subscriptionId: after.stripeSubscriptionId, created: false }
      }
    }
    throw new Error(
      `ensurePlatformSubscription: subscription_creation_in_progress for ${wbCustomerId}`,
    )
  }

  // We hold the claim. From here, only one process is calling Stripe.
  const platformCustomerId =
    row.stripePlatformCustomerId ??
    (await getOrCreatePlatformCustomer(wbCustomerId))

  const stripe = getPlatformStripe()
  const priceId =
    flatRateCents !== null
      ? await createCustomFlatRatePrice(stripe, wbCustomerId, flatRateCents)
      : await tierPriceId(stripe, resolvedTier!)

  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptions.create(
      {
        customer: platformCustomerId,
        items: [{ price: priceId }],
        proration_behavior: 'create_prorations',
        collection_method: 'charge_automatically',
        metadata: {
          winback_customer_id: wbCustomerId,
          winback_tier: flatRateCents !== null ? 'custom' : resolvedTier!,
        },
      },
      { idempotencyKey: `wb-sub-${wbCustomerId}-${claimedAt.getTime()}` },
    )
  } catch (err) {
    // Release the claim so a retry can proceed without waiting for TTL.
    await db
      .update(customers)
      .set({ stripeSubscriptionCreatingAt: null, updatedAt: new Date() })
      .where(eq(customers.id, wbCustomerId))
    throw err
  }

  const now = new Date()
  await db
    .update(customers)
    .set({
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionCreatingAt: null,
      activatedAt: now,
      billedTier: flatRateCents !== null ? 'custom' : resolvedTier!,
      billedChangedAt: now,
      // 2026-05-29 — auto-un-pause both scopes. If the merchant
      // previously hit "I'm done · pause" on the dashboard banner
      // (which sets both pausedAt + pausedDunningAt) and is now
      // subscribing, we treat the subscribe as the strongest possible
      // "I want this running" signal — null both timestamps so sends
      // resume immediately. Without this, the merchant subscribes,
      // sees healthy billing, and silently still gets no sends.
      pausedAt:        null,
      pausedDunningAt: null,
      updatedAt: now,
    })
    .where(eq(customers.id, wbCustomerId))

  return { subscriptionId: subscription.id, created: true }
}

/**
 * Cancels the platform subscription. Default cancels at period end.
 * Pass `immediately: true` to terminate now.
 *
 * Idempotent — no-op if there is no active subscription.
 *
 * Note: webhook-driven platform-side subscription.deleted handles the
 * follow-up — it clears billed_tier and resets status to pre_billing so
 * the customer can re-onramp on a future delivered recovery.
 */
export async function cancelPlatformSubscription(
  wbCustomerId: string,
  opts: { immediately?: boolean } = {},
): Promise<void> {
  const [row] = await db
    .select({ stripeSubscriptionId: customers.stripeSubscriptionId })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  if (!row?.stripeSubscriptionId) return

  const stripe = getPlatformStripe()
  if (opts.immediately) {
    await stripe.subscriptions.cancel(row.stripeSubscriptionId)
  } else {
    await stripe.subscriptions.update(row.stripeSubscriptionId, {
      cancel_at_period_end: true,
    })
  }
}

/**
 * Returns the current Stripe Subscription status, or null if no
 * subscription exists for this customer.
 */
export async function getSubscriptionStatus(
  wbCustomerId: string,
): Promise<SubscriptionStatus> {
  const details = await getSubscriptionDetails(wbCustomerId)
  return details?.status ?? null
}

export interface SubscriptionDetails {
  subscriptionId: string
  status: SubscriptionStatus
  cancelAtPeriodEnd: boolean
  currentPeriodEnd: Date | null
}

export async function getSubscriptionDetails(
  wbCustomerId: string,
): Promise<SubscriptionDetails | null> {
  const [row] = await db
    .select({ stripeSubscriptionId: customers.stripeSubscriptionId })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  if (!row?.stripeSubscriptionId) return null

  try {
    const stripe = getPlatformStripe()
    const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId)
    const subAny = sub as Stripe.Subscription & { current_period_end?: number }
    const itemPeriodEnd = sub.items?.data[0] as
      | (Stripe.SubscriptionItem & { current_period_end?: number })
      | undefined
    const periodEndUnix =
      subAny.current_period_end ?? itemPeriodEnd?.current_period_end ?? null
    return {
      subscriptionId: sub.id,
      status: sub.status as SubscriptionStatus,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      currentPeriodEnd: periodEndUnix ? new Date(periodEndUnix * 1000) : null,
    }
  } catch {
    return null
  }
}

export async function reactivatePlatformSubscription(
  wbCustomerId: string,
): Promise<void> {
  const [row] = await db
    .select({ stripeSubscriptionId: customers.stripeSubscriptionId })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  if (!row?.stripeSubscriptionId) return

  const stripe = getPlatformStripe()
  await stripe.subscriptions.update(row.stripeSubscriptionId, {
    cancel_at_period_end: false,
  })
}

/**
 * Switches an active platform subscription to a different tier's Price.
 * Used by the upgrade/downgrade flow (called by the Stripe Customer
 * Portal flow OR by an in-app prompt's confirmation handler).
 *
 * No proration by default — the customer requested this change explicitly,
 * and they paid for the current cycle at the old rate. The next invoice
 * bills the new amount.
 */
export async function switchTier(
  wbCustomerId: string,
  newTier: TierKey,
): Promise<{ priceUpdated: boolean }> {
  if (newTier === 'enterprise') {
    throw new Error(
      `switchTier: enterprise is sales-handled — refusing to auto-switch ${wbCustomerId}`,
    )
  }

  const [row] = await db
    .select({ stripeSubscriptionId: customers.stripeSubscriptionId })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)
  if (!row?.stripeSubscriptionId) return { priceUpdated: false }

  const stripe = getPlatformStripe()
  const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId)
  const itemId = sub.items.data[0]?.id
  if (!itemId) return { priceUpdated: false }

  const newPriceId = await tierPriceId(stripe, newTier)
  await stripe.subscriptions.update(row.stripeSubscriptionId, {
    items: [{ id: itemId, price: newPriceId }],
    proration_behavior: 'create_prorations',
    metadata: { winback_tier: newTier },
  })

  const now = new Date()
  await db
    .update(customers)
    .set({
      billedTier: newTier,
      billedChangedAt: now,
      updatedAt: now,
    })
    .where(eq(customers.id, wbCustomerId))

  return { priceUpdated: true }
}

/**
 * Reads the current tier on the Stripe subscription's Price and returns
 * it. Used by the platform-side subscription.updated webhook to keep
 * billed_tier in sync if Stripe changes the Price (e.g., via Customer
 * Portal). Returns null when the Price doesn't map to a known tier
 * (custom flat-rate, or stale config).
 */
export async function syncBilledTierFromStripe(
  wbCustomerId: string,
  subscription: Stripe.Subscription,
): Promise<TierKey | null> {
  const priceId = subscription.items.data[0]?.price?.id
  if (!priceId) return null

  const stripe = getPlatformStripe()
  const tier = await tierFromPriceId(stripe, priceId)
  if (!tier) return null

  const now = new Date()
  await db
    .update(customers)
    .set({
      billedTier: tier,
      billedChangedAt: now,
      updatedAt: now,
    })
    .where(eq(customers.id, wbCustomerId))

  return tier
}

// ─────────────────────────────────────────────────────────────────────
// Custom flat-rate billing (Spec 77 — carve-out preserved through rewrite)
// ─────────────────────────────────────────────────────────────────────
//
// When customers.custom_monthly_cents is set, the tier ladder is
// ignored entirely — we mint a one-off Stripe Price at the negotiated
// amount and bill that. Used for strategic / enterprise / pilot-graduate
// deals where standard tiers don't fit.

async function createCustomFlatRatePrice(
  stripe: Stripe,
  wbCustomerId: string,
  cents: number,
): Promise<string> {
  const product = await stripe.products.create({
    name: `Winback Custom Plan (${wbCustomerId.slice(0, 8)})`,
    metadata: {
      winback_role: 'custom_flat_rate',
      customer_id: wbCustomerId,
    },
  })
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: cents,
    currency: PLATFORM_FEE_CURRENCY,
    recurring: { interval: 'month' },
    metadata: {
      winback_role: 'custom_flat_rate',
      customer_id: wbCustomerId,
    },
  })
  return price.id
}

/**
 * Switches a customer onto a flat-rate plan. Updates the column and, if
 * a Stripe subscription already exists, swaps its Price item to the new
 * custom Price (no proration).
 *
 * If the customer has no active sub yet, step 2 is skipped. When they
 * later activate, ensurePlatformSubscription will see the column and
 * subscribe on a custom Price instead of a tier Price.
 */
export async function switchCustomerToFlatRate(
  wbCustomerId: string,
  cents: number,
  opts: { adminEmail: string | null } = { adminEmail: null },
): Promise<{ priceUpdated: boolean }> {
  await db
    .update(customers)
    .set({ customMonthlyCents: cents, updatedAt: new Date() })
    .where(eq(customers.id, wbCustomerId))

  const [row] = await db
    .select({ stripeSubscriptionId: customers.stripeSubscriptionId })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  let priceUpdated = false
  if (row?.stripeSubscriptionId) {
    const stripe = getPlatformStripe()
    const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId)
    const itemId = sub.items.data[0]?.id
    if (itemId) {
      const newPriceId = await createCustomFlatRatePrice(
        stripe,
        wbCustomerId,
        cents,
      )
      await stripe.subscriptions.update(row.stripeSubscriptionId, {
        items: [{ id: itemId, price: newPriceId }],
        proration_behavior: 'none',
      })
      const now = new Date()
      await db
        .update(customers)
        .set({ billedTier: 'custom', billedChangedAt: now, updatedAt: now })
        .where(eq(customers.id, wbCustomerId))
      priceUpdated = true
    }
  }

  await logEvent({
    name: 'flat_rate_assigned',
    customerId: wbCustomerId,
    properties: {
      customMonthlyCents: cents,
      adminEmail: opts.adminEmail,
      priceUpdatedOnStripe: priceUpdated,
    },
  })

  return { priceUpdated }
}

/**
 * Reverts a customer from a flat-rate plan back to the standard tiered
 * model. Their recommended_tier (set by the snapshot cron from smoothed
 * MRR) becomes the new billed tier when the Stripe Price swap fires.
 *
 * If recommended_tier is null (no snapshots yet — unusual for an
 * existing flat-rate customer), the swap is skipped and the column is
 * still cleared. ensurePlatformSubscription will pick the correct tier
 * on the next interaction.
 */
export async function revertCustomerToStandardRate(
  wbCustomerId: string,
  opts: { adminEmail: string | null } = { adminEmail: null },
): Promise<{ priceUpdated: boolean }> {
  await db
    .update(customers)
    .set({ customMonthlyCents: null, updatedAt: new Date() })
    .where(eq(customers.id, wbCustomerId))

  const [row] = await db
    .select({
      stripeSubscriptionId: customers.stripeSubscriptionId,
      recommendedTier: customers.recommendedTier,
    })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  let priceUpdated = false
  if (row?.stripeSubscriptionId && row.recommendedTier) {
    const target = row.recommendedTier as TierKey
    if (target !== 'enterprise') {
      const stripe = getPlatformStripe()
      const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId)
      const itemId = sub.items.data[0]?.id
      if (itemId) {
        const standardPriceId = await tierPriceId(stripe, target)
        await stripe.subscriptions.update(row.stripeSubscriptionId, {
          items: [{ id: itemId, price: standardPriceId }],
          proration_behavior: 'none',
        })
        const now = new Date()
        await db
          .update(customers)
          .set({ billedTier: target, billedChangedAt: now, updatedAt: now })
          .where(eq(customers.id, wbCustomerId))
        priceUpdated = true
      }
    }
  }

  await logEvent({
    name: 'flat_rate_cleared',
    customerId: wbCustomerId,
    properties: {
      adminEmail: opts.adminEmail,
      priceUpdatedOnStripe: priceUpdated,
    },
  })

  return { priceUpdated }
}

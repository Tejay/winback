import type Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq, and, isNull, or, lt } from 'drizzle-orm'
import { getPlatformStripe } from './platform-stripe'
import { getOrCreatePlatformCustomer } from './platform-billing'
import { getCustomMonthlyCents } from './flat-rate'
import { logEvent } from './events'

/**
 * Phase A — Stripe Subscription primitives for the new $99/mo platform fee.
 *
 * The platform fee is delivered as a recurring Stripe Subscription on
 * Winback's own Stripe account (not the merchant's connected account).
 * Stripe handles billing cycles, proration on first invoice, dunning, and
 * payment retries. This file owns subscription create/cancel/status only;
 * win-back performance fees are added as one-off invoice items onto the
 * subscription's pending invoice and live in performance-fee.ts.
 *
 * Activation timing is owned by activation.ts. This file is only called by
 * activation.ts (and tests).
 */

export const PLATFORM_FEE_CENTS = 9900 // $99/mo
export const PLATFORM_FEE_CURRENCY = 'usd'
const PRICE_LOOKUP_KEY = 'winback_platform_monthly_v1'

/**
 * Returns a usable Price ID for the platform monthly subscription.
 *
 * Resolution order:
 *   1. STRIPE_PLATFORM_FEE_PRICE_ID env var (operator-managed) — preferred
 *      for production so the Price is visible in the Stripe dashboard.
 *   2. Existing Price with lookup_key='winback_platform_monthly_v1'.
 *   3. Create the Product + Price with that lookup_key on demand.
 */
async function getOrCreatePlatformPriceId(stripe: Stripe): Promise<string> {
  const fromEnv = process.env.STRIPE_PLATFORM_FEE_PRICE_ID
  if (fromEnv) return fromEnv

  const list = await stripe.prices.list({
    lookup_keys: [PRICE_LOOKUP_KEY],
    active: true,
    limit: 1,
  })
  if (list.data[0]) return list.data[0].id

  const product = await stripe.products.create({
    name: 'Winback Platform',
    metadata: { winback_role: 'platform_fee' },
  })
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: PLATFORM_FEE_CENTS,
    currency: PLATFORM_FEE_CURRENCY,
    recurring: { interval: 'month' },
    lookup_key: PRICE_LOOKUP_KEY,
  })
  return price.id
}

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

/**
 * Idempotent. Returns the existing Stripe Subscription ID for this customer
 * if one is already active; otherwise creates a new $99/mo subscription
 * anchored at now() (Stripe will prorate the first cycle).
 *
 * Caller responsibility: payment method must already be on file. This
 * function does not check for a card; Stripe will refuse to create the
 * subscription if there's no default PM and `collection_method` is
 * `charge_automatically`. Treat the throw as expected if you call this
 * without verifying card presence first.
 */
// Spec 52 — TTL on the creation lock. A claim older than this (i.e., a
// crashed claimer) can be reclaimed by the next caller. 30s is wide
// enough to comfortably cover one Stripe subscriptions.create call
// (~500ms typical, sometimes much longer under back-pressure) plus the
// subsequent UPDATE.
const SUBSCRIPTION_CREATION_LOCK_TTL_MS = 30_000

// Spec 52 + Spec 60 — race-loser polling. Tier 2.2 showed the winner
// can take 3-6s end-to-end (chargePendingPerformanceFees + Stripe API
// + UPDATE), longer than the original 1s sleep-once window. The loser
// now polls every POLL_INTERVAL_MS for up to TOTAL_WAIT_MS, returning
// as soon as the winner writes stripe_subscription_id. Falls through
// to the same throw if the total window expires (upstream try/catch
// renders the "pending" tone in `/billing/success`).
const SUBSCRIPTION_CREATION_RACE_POLL_INTERVAL_MS = 500
const SUBSCRIPTION_CREATION_RACE_TOTAL_WAIT_MS = 10_000

export async function ensurePlatformSubscription(
  wbCustomerId: string,
): Promise<{ subscriptionId: string; created: boolean }> {
  const [row] = await db
    .select({
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
      stripeSubscriptionId: customers.stripeSubscriptionId,
    })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  if (!row) throw new Error(`wb_customer ${wbCustomerId} not found`)

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
      // Cached ID is stale (deleted in Stripe); fall through to create
    }
  }

  // Spec 52 — race fence. /billing/success and the
  // checkout.session.completed webhook both reach here in parallel on a
  // normal Subscribe completion. Without this claim, both would pass the
  // pre-check above and both would call stripe.subscriptions.create,
  // producing an orphan subscription that bills the customer with no DB
  // record. The conditional UPDATE is atomic — only one caller's
  // .returning() is non-empty.
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
    // Spec 60 — Lost the race. Poll for the winner to finish writing the
    // sub id, every POLL_INTERVAL_MS for up to TOTAL_WAIT_MS. Returns as
    // soon as the winner's row appears, capping the loser's wait at the
    // winner's actual completion time (+ one poll interval), rather than
    // a fixed sleep. Tier 2.2 measured winners completing at ~3-6s; the
    // 10s cap leaves comfortable headroom for Stripe back-pressure.
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
    // The other claimer is still in flight beyond our total wait, or
    // crashed. The caller can retry — by then either the row will have
    // a subscription_id (this branch returns it) or the lock will be
    // past TTL (next attempt successfully claims). Upstream's try/catch
    // in /billing/success renders the "pending" tone for the user.
    throw new Error(
      `ensurePlatformSubscription: subscription_creation_in_progress for ${wbCustomerId}`,
    )
  }

  // We hold the claim. From here, only one process is calling Stripe.
  const platformCustomerId =
    row.stripePlatformCustomerId ?? (await getOrCreatePlatformCustomer(wbCustomerId))

  const stripe = getPlatformStripe()
  // Spec 77 — customer-aware Price selection. Standard customers get
  // the shared $99/mo Price; flat-rate customers get a one-off Price
  // at their negotiated amount.
  const priceId = await getPlatformPriceIdForCustomer(stripe, wbCustomerId)

  let subscription: Stripe.Subscription
  try {
    // Spec 59 — Stripe Idempotency-Key. Stable for the duration of this
    // call (so Stripe SDK auto-retries on transient 5xx/network errors
    // reuse the cached response). Different across cancel + re-activate
    // cycles because `claimedAt` is re-set by each new lock claim.
    // Belt-and-suspenders to the Spec 52 DB race-fence above.
    subscription = await stripe.subscriptions.create(
      {
        customer: platformCustomerId,
        items: [{ price: priceId }],
        proration_behavior: 'create_prorations',
        collection_method: 'charge_automatically',
        metadata: { winback_customer_id: wbCustomerId },
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

  await db
    .update(customers)
    .set({
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionCreatingAt: null,
      activatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(customers.id, wbCustomerId))

  return { subscriptionId: subscription.id, created: true }
}

/**
 * Cancels the platform subscription. Default cancels at period end (customer
 * keeps access through the current cycle, final cycle invoices normally).
 * Pass `immediately: true` to terminate now — used by workspace deletion,
 * where Stripe issues a prorated final invoice for the unused portion.
 *
 * Idempotent — no-op if there is no active subscription.
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
 * Returns the current Stripe Subscription status, or null if no subscription
 * exists for this customer. Maps directly to Stripe's `status` field; callers
 * decide what counts as "billing-active" (typically: active | trialing |
 * past_due).
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

/**
 * Fetches subscription status plus the cancel-at-period-end flag and the
 * current period's end date — needed by the UI to render the Cancel / Resume
 * buttons and the "Subscription ends Aug 27" notice when a cancel is queued.
 */
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
    // Stripe API moved `current_period_end` onto items in newer versions
    // but older API versions still return it at the top level. Read both
    // and prefer whichever is present so the helper works either way.
    const subAny = sub as Stripe.Subscription & { current_period_end?: number }
    const itemPeriodEnd = sub.items?.data[0] as
      | (Stripe.SubscriptionItem & { current_period_end?: number })
      | undefined
    const periodEndUnix = subAny.current_period_end ?? itemPeriodEnd?.current_period_end ?? null
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

/**
 * Reverses a `cancel_at_period_end` request — used by the "Resume" button
 * when a customer changes their mind before the cycle ends. No-op if there
 * is no subscription on file.
 */
export async function reactivatePlatformSubscription(wbCustomerId: string): Promise<void> {
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

// ─────────────────────────────────────────────────────────────────────
// Spec 77 — Custom flat-rate billing
// ─────────────────────────────────────────────────────────────────────
//
// Wraps the standard `getOrCreatePlatformPriceId` so that callers
// (currently just ensurePlatformSubscription) can choose the right Price
// based on whether the customer is on a custom flat-rate deal.
//
// Spec deviation noted in same commit: the spec originally described
// "cancel old sub at period-end, create new sub at custom Price."
// The actual implementation updates the existing subscription's price
// item with `proration_behavior: 'none'` — identical end-user behavior
// (no proration, next invoice at new amount) but one Stripe Subscription
// lifecycle instead of two. Simpler code, no "subscription cancelled"
// email noise to the merchant.

/**
 * Returns the Price ID to use for THIS customer's platform subscription.
 * For standard customers, returns the shared $99/mo Price. For flat-rate
 * customers, creates a one-off Price at their negotiated amount.
 *
 * One-off Prices for flat-rate customers are created fresh each time
 * (Prices are immutable in Stripe), tagged with metadata for dashboard
 * audit (`winback_role: 'custom_flat_rate'`, `customer_id`).
 */
async function getPlatformPriceIdForCustomer(
  stripe: Stripe,
  wbCustomerId: string,
): Promise<string> {
  const flatRateCents = await getCustomMonthlyCents(wbCustomerId)
  if (flatRateCents !== null) {
    return createCustomFlatRatePrice(stripe, wbCustomerId, flatRateCents)
  }
  return getOrCreatePlatformPriceId(stripe)
}

/**
 * Creates a fresh Stripe Product+Price for a flat-rate customer at the
 * specified monthly cents. Stripe Prices are immutable — each (customer,
 * amount) pair gets its own Price. Tagged so it's findable in the
 * Stripe dashboard by customer or role.
 */
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
 * Switches a customer onto a flat-rate plan. Idempotent on the column
 * write; the Stripe-side swap only fires when there's an active sub.
 *
 * Behavior:
 *   1. Set `customers.custom_monthly_cents = cents` (atomic single
 *      column write).
 *   2. If the customer has an active Stripe Subscription, update its
 *      Price item to a fresh custom Price at the new amount. No
 *      proration — next invoice bills the new amount; current invoice
 *      (if mid-cycle) bills the old amount as scheduled.
 *   3. Emit `flat_rate_assigned` event for the audit trail.
 *
 * If the customer has no active sub yet (signed up but never connected
 * Stripe Connect), step 2 is skipped. When they later complete
 * onboarding, ensurePlatformSubscription will see the column and create
 * the sub at the custom Price via getPlatformPriceIdForCustomer.
 */
export async function switchCustomerToFlatRate(
  wbCustomerId: string,
  cents: number,
  opts: { adminEmail: string | null } = { adminEmail: null },
): Promise<{ priceUpdated: boolean }> {
  // 1. Set the column.
  await db
    .update(customers)
    .set({ customMonthlyCents: cents, updatedAt: new Date() })
    .where(eq(customers.id, wbCustomerId))

  // 2. Update the existing sub if there is one.
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
      const newPriceId = await createCustomFlatRatePrice(stripe, wbCustomerId, cents)
      await stripe.subscriptions.update(row.stripeSubscriptionId, {
        items: [{ id: itemId, price: newPriceId }],
        proration_behavior: 'none',
      })
      priceUpdated = true
    }
  }

  // 3. Audit.
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
 * Reverts a customer from a flat-rate plan back to the standard $99/mo +
 * perf-fee model. Inverse of switchCustomerToFlatRate.
 *
 * Behavior:
 *   1. Set `customers.custom_monthly_cents = NULL`.
 *   2. If the customer has an active sub, update its Price item back to
 *      the standard $99 Price. No proration.
 *   3. Emit `flat_rate_cleared` event.
 *
 * Perf fees resume on the next recovery (the bypass gate in
 * performance-fee.ts reads the column live).
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
      const standardPriceId = await getOrCreatePlatformPriceId(stripe)
      await stripe.subscriptions.update(row.stripeSubscriptionId, {
        items: [{ id: itemId, price: standardPriceId }],
        proration_behavior: 'none',
      })
      priceUpdated = true
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

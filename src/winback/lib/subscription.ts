import type Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getPlatformStripe } from './platform-stripe'
import { getOrCreatePlatformCustomer } from './platform-billing'

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

  const platformCustomerId =
    row.stripePlatformCustomerId ?? (await getOrCreatePlatformCustomer(wbCustomerId))

  const stripe = getPlatformStripe()
  const priceId = await getOrCreatePlatformPriceId(stripe)

  const subscription = await stripe.subscriptions.create({
    customer: platformCustomerId,
    items: [{ price: priceId }],
    proration_behavior: 'create_prorations',
    collection_method: 'charge_automatically',
    metadata: { winback_customer_id: wbCustomerId },
  })

  await db
    .update(customers)
    .set({
      stripeSubscriptionId: subscription.id,
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

/**
 * Spec — billing-health enforcement.
 *
 * Problem (2026-05-18):
 *   Merchants whose platform subscription falls into a non-paying state
 *   (incomplete_expired / canceled / unpaid) continue to consume real
 *   Anthropic + Resend spend because no code path checks "is this
 *   merchant actually paying?" before classifying or sending. This is a
 *   freeloading vector at scale.
 *
 * This module exposes one function — `isCustomerBillingHealthy(customerId)`
 * — that returns `false` when the merchant's Stripe subscription is in
 * a state we should NOT spend on their behalf:
 *
 *   active             → healthy
 *   trialing           → healthy
 *   past_due           → healthy   (Stripe is mid-retry; legitimate dunning)
 *   incomplete         → healthy   (sub just created; first invoice pending)
 *   incomplete_expired → UNHEALTHY (terminal — sub setup never completed)
 *   canceled           → UNHEALTHY (explicit cancellation)
 *   unpaid             → UNHEALTHY (retries exhausted, sub suspended)
 *   paused             → UNHEALTHY (intentional Stripe-side pause)
 *
 * Customers with no Stripe subscription yet (haven't activated, or
 * activated but no card yet) are treated as healthy — the "$0 until
 * first save" promise should hold for pre-activation merchants.
 *
 * Call sites:
 *   - src/winback/lib/classifier-tick.ts — skip the row per tick if
 *     unhealthy (leaves classified_at NULL so it resumes when billing
 *     heals)
 *   - src/winback/lib/email.ts — skip sendEmail / sendReplyEmail /
 *     sendDunningEmail / sendDunningFollowupEmail when unhealthy
 *
 * Visible at the customer in: components/billing-paused-banner.tsx —
 * red strip on the dashboard explaining the suspension.
 *
 * Caching: in-memory TTL of 5 minutes per customer-id. Survives within
 * a single Vercel function instance; cold instances will re-read.
 * Acceptable because the underlying state changes rarely (sub status
 * transitions happen on the order of hours/days, not seconds).
 */
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getPlatformStripe } from './platform-stripe'

const UNHEALTHY_SUB_STATUSES = new Set<string>([
  'incomplete_expired',
  'canceled',
  'unpaid',
  'paused',
])

const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  healthy:   boolean
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Returns true when we should perform billable work on the merchant's
 * behalf (classification, email sends), false when we should skip and
 * surface a banner instead.
 *
 * Customers with no stripeSubscriptionId on file are healthy — they
 * haven't been billed yet and the "$0 until first delivery" promise
 * applies.
 */
export async function isCustomerBillingHealthy(customerId: string): Promise<boolean> {
  const now = Date.now()
  const cached = cache.get(customerId)
  if (cached && cached.expiresAt > now) {
    return cached.healthy
  }

  const [row] = await db
    .select({ stripeSubscriptionId: customers.stripeSubscriptionId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)

  // No sub on file → pre-activation merchant. Healthy by definition;
  // we won't be charging them anything yet.
  if (!row?.stripeSubscriptionId) {
    cache.set(customerId, { healthy: true, expiresAt: now + CACHE_TTL_MS })
    return true
  }

  let healthy = true
  try {
    const stripe = getPlatformStripe()
    const sub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId)
    healthy = !UNHEALTHY_SUB_STATUSES.has(sub.status)
  } catch {
    // Stripe error / sub deleted entirely → treat as healthy so a
    // transient API blip doesn't pause every merchant. The next cache
    // expiry will re-check.
    healthy = true
  }

  cache.set(customerId, { healthy, expiresAt: now + CACHE_TTL_MS })
  return healthy
}

/**
 * Subscriber-keyed wrapper for callers that have a subscriberId in
 * hand (most send functions in email.ts). Joins subscriber → customer
 * once, then delegates so the per-customer cache is shared with
 * direct `isCustomerBillingHealthy(customerId)` callers.
 */
export async function isCustomerBillingHealthy_BySubscriber(
  subscriberId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ customerId: churnedSubscribers.customerId })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  // Subscriber not found → fail-open (return healthy) so a stale
  // subscriber-id reference never blocks an unrelated send. The other
  // pre-checks (isDoNotContact, etc.) will catch genuinely-missing rows.
  if (!row) return true
  return isCustomerBillingHealthy(row.customerId)
}

/**
 * Test-only — clears the in-memory cache so unit tests don't bleed
 * state across cases. Not exported via the public boundary.
 */
export function _resetBillingCacheForTesting(): void {
  cache.clear()
}

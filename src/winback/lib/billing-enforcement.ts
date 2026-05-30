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
 * Pre-subscription policy (2026-05-29 — anti-free-rider gate):
 *   - activatedAt IS NULL                       → healthy (no save yet,
 *     "$0 until first save" promise holds)
 *   - activatedAt IS NOT NULL AND no sub        → UNHEALTHY (first save
 *     delivered, no card on file — the celebration banner asks for one;
 *     classifier + sends pause until the merchant adds a card)
 *   - pilotUntil > now()                        → healthy (pilots bypass
 *     the gate regardless of activation/sub state)
 *
 * Call sites — BULK / background paths only (the cache earns its keep
 * here because these loop over many subscribers per cron and would
 * otherwise hammer Stripe):
 *   - src/winback/lib/classifier-tick.ts — skip the row per tick if
 *     unhealthy (leaves classified_at NULL so it resumes when billing
 *     heals)
 *   - src/winback/lib/email.ts — skip sendEmail / sendReplyEmail /
 *     sendDunningEmail / sendDunningFollowupEmail when unhealthy
 *
 * NOT used by the dashboard red banner. As of 2026-05-30 the
 * BillingPausedBanner is driven by a LIVE Stripe sub-status read in
 * app/dashboard/page.tsx (getSubscriptionDetails), not this cached
 * value — a user-facing banner must never show a stale answer from the
 * wrong module instance. This cache tolerates a few minutes of
 * staleness because a cron firing slightly stale is invisible; a
 * merchant staring at a wrong banner is not. The two paths
 * deliberately use the same UNHEALTHY_SUB_STATUSES set so they agree.
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
 * Pre-subscription merchants: healthy while activatedAt IS NULL, then
 * unhealthy once activated (= proof-of-value delivered) until they
 * either add a card OR the pilot window covers them. See module header
 * for the full policy.
 */
export async function isCustomerBillingHealthy(customerId: string): Promise<boolean> {
  const now = Date.now()
  const cached = cache.get(customerId)
  if (cached && cached.expiresAt > now) {
    return cached.healthy
  }

  const [row] = await db
    .select({
      stripeSubscriptionId: customers.stripeSubscriptionId,
      activatedAt:          customers.activatedAt,
      pilotUntil:           customers.pilotUntil,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)

  // Pilot carve-out: an active pilot bypasses every other gate. This
  // mirrors the bypass in activation.ts (no platform sub is ever
  // created during a pilot window) so the same merchant doesn't get
  // paused by THIS gate while their pilot covers them.
  const onPilot = !!row?.pilotUntil && row.pilotUntil.getTime() > now
  if (onPilot) {
    cache.set(customerId, { healthy: true, expiresAt: now + CACHE_TTL_MS })
    return true
  }

  // No sub on file. Two sub-cases now (2026-05-29 gate flip):
  //   - activatedAt IS NULL → still pre-activation, healthy. The
  //     "$0 until first save" promise holds; classifier + sends run.
  //   - activatedAt IS NOT NULL → first save delivered, no card on
  //     file. Pause until they subscribe. The dashboard banner
  //     ("Add a card · unlock the queue") IS the ask; this gate is
  //     what makes that ask true.
  if (!row?.stripeSubscriptionId) {
    const healthy = !row?.activatedAt
    cache.set(customerId, { healthy, expiresAt: now + CACHE_TTL_MS })
    return healthy
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

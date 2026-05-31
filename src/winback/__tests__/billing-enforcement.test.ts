/**
 * Spec — billing-enforcement gate (2026-05-18).
 *
 * Verifies isCustomerBillingHealthy() returns the right value per
 * Stripe sub status, treats pre-activation merchants as healthy, and
 * caches results so it doesn't hammer Stripe on every send.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect             = vi.hoisted(() => vi.fn())
const mockSubscriptionsRetrieve = vi.hoisted(() => vi.fn())
const mockGetPlatformStripe = vi.hoisted(() => vi.fn(() => ({
  subscriptions: { retrieve: mockSubscriptionsRetrieve },
})))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect },
}))

vi.mock('@/lib/schema', () => ({
  customers:          { id: 'id', stripeSubscriptionId: 'stripe_subscription_id' },
  churnedSubscribers: { id: 'id', customerId: 'customer_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}))

vi.mock('../lib/platform-stripe', () => ({
  getPlatformStripe: mockGetPlatformStripe,
}))

import {
  isCustomerBillingHealthy,
  isCustomerBillingHealthy_BySubscriber,
  _resetBillingCacheForTesting,
} from '../lib/billing-enforcement'

function selectReturning<T>(rows: T[]) {
  // Mirror Drizzle's select().from().where().limit() chain.
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetBillingCacheForTesting()
})

describe('isCustomerBillingHealthy', () => {
  it('returns true when customer has no stripeSubscriptionId yet (pre-activation merchant)', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([{ stripeSubscriptionId: null }]))

    expect(await isCustomerBillingHealthy('cust_new')).toBe(true)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  // 2026-05-29 — first-save paywall gate (PR #169). Once a recovery is
  // delivered (activatedAt set) but the merchant hasn't subscribed, we
  // stop spending on their behalf. This is the anti-free-rider gate.
  it('returns FALSE when activated but no sub on file (first-save paywall gate)', async () => {
    mockSelect.mockReturnValueOnce(
      selectReturning([{ stripeSubscriptionId: null, activatedAt: new Date('2026-05-20'), pilotUntil: null }]),
    )

    expect(await isCustomerBillingHealthy('cust_activated_unpaid')).toBe(false)
    // No Stripe call — the gate decides from DB state alone.
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('returns TRUE for an active pilot even when activated with no sub (pilot bypass)', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    mockSelect.mockReturnValueOnce(
      selectReturning([{ stripeSubscriptionId: null, activatedAt: new Date('2026-05-20'), pilotUntil: future }]),
    )

    expect(await isCustomerBillingHealthy('cust_pilot')).toBe(true)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })

  it('applies the gate once the pilot window has expired (activated, no sub, pilot in past)', async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000)
    mockSelect.mockReturnValueOnce(
      selectReturning([{ stripeSubscriptionId: null, activatedAt: new Date('2026-05-20'), pilotUntil: past }]),
    )

    expect(await isCustomerBillingHealthy('cust_pilot_expired')).toBe(false)
  })

  it.each([
    ['active',     true],
    ['trialing',   true],
    ['past_due',   true],   // Stripe is mid-retry; legitimate dunning, keep service
    ['incomplete', true],   // sub just created; first invoice still pending
  ] as const)('returns true for status=%s (healthy)', async (status, expected) => {
    mockSelect.mockReturnValueOnce(selectReturning([{ stripeSubscriptionId: 'sub_x' }]))
    mockSubscriptionsRetrieve.mockResolvedValueOnce({ status })

    expect(await isCustomerBillingHealthy('cust_x')).toBe(expected)
  })

  it.each([
    'incomplete_expired',  // terminal — sub setup never completed
    'canceled',            // explicit cancellation
    'unpaid',              // retries exhausted, sub suspended
    'paused',              // intentional Stripe-side pause
  ])('returns false for status=%s (unhealthy)', async (status) => {
    mockSelect.mockReturnValueOnce(selectReturning([{ stripeSubscriptionId: 'sub_x' }]))
    mockSubscriptionsRetrieve.mockResolvedValueOnce({ status })

    expect(await isCustomerBillingHealthy('cust_x')).toBe(false)
  })

  it('caches the result within TTL — second call does not hit Stripe', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([{ stripeSubscriptionId: 'sub_x' }]))
    mockSubscriptionsRetrieve.mockResolvedValueOnce({ status: 'active' })

    expect(await isCustomerBillingHealthy('cust_cached')).toBe(true)
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledTimes(1)

    // Second call within TTL — no new Stripe call
    expect(await isCustomerBillingHealthy('cust_cached')).toBe(true)
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledTimes(1)
  })

  it('fails open (returns true) when Stripe throws — transient API blip should not pause every merchant', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([{ stripeSubscriptionId: 'sub_x' }]))
    mockSubscriptionsRetrieve.mockRejectedValueOnce(new Error('Stripe down'))

    expect(await isCustomerBillingHealthy('cust_err')).toBe(true)
  })
})

describe('isCustomerBillingHealthy_BySubscriber', () => {
  it('joins subscriber → customer then delegates to the cached customer-level check', async () => {
    // First call: subscriber lookup
    mockSelect.mockReturnValueOnce(selectReturning([{ customerId: 'cust_z' }]))
    // Second call: customer lookup inside isCustomerBillingHealthy
    mockSelect.mockReturnValueOnce(selectReturning([{ stripeSubscriptionId: 'sub_z' }]))
    mockSubscriptionsRetrieve.mockResolvedValueOnce({ status: 'canceled' })

    expect(await isCustomerBillingHealthy_BySubscriber('sub_row_id')).toBe(false)
  })

  it('returns true when the subscriber row is missing (fail-open)', async () => {
    mockSelect.mockReturnValueOnce(selectReturning([]))

    expect(await isCustomerBillingHealthy_BySubscriber('sub_missing')).toBe(true)
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled()
  })
})

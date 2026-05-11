/**
 * Spec 51 — isCustomerPausedForBilling()
 *
 * Verifies the helper that gates win-back + payment-recovery email sends
 * for customers in the post-trial paused state:
 *   - returns true when activatedAt is set AND no stripeSubscriptionId
 *   - returns false when activatedAt is null (trial not complete)
 *   - returns false when stripeSubscriptionId is set (subscribed)
 *   - returns false when pilotUntil > now (pilot bypass)
 *   - returns false when no row found (subscriber doesn't exist)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect },
}))

vi.mock('@/lib/schema', () => ({
  customers: { activatedAt: 'a', stripeSubscriptionId: 's', pilotUntil: 'p' },
  churnedSubscribers: { id: 'cs.id', customerId: 'cs.customer_id' },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
}))

vi.mock('../lib/events', () => ({
  logEvent: vi.fn().mockResolvedValue(undefined),
}))

function setRow(row: Record<string, unknown> | null) {
  mockSelect.mockImplementation(() => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          limit: () => (row ? [row] : []),
        }),
      }),
    }),
  }))
}

// Spec 53 — the customer-keyed variant skips the innerJoin (no need to
// resolve subscriber -> customer; the caller already has customerId).
function setCustomerRow(row: Record<string, unknown> | null) {
  mockSelect.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: () => (row ? [row] : []),
      }),
    }),
  }))
}

import {
  isCustomerPausedForBilling,
  isCustomerPausedForBillingByCustomerId,
} from '../lib/email'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('isCustomerPausedForBilling', () => {
  it('returns true: activatedAt set + no subscription + not on pilot', async () => {
    setRow({
      activatedAt: new Date(),
      stripeSubscriptionId: null,
      pilotUntil: null,
    })
    expect(await isCustomerPausedForBilling('sub_1')).toBe(true)
  })

  it('returns false: activatedAt is null (trial not complete)', async () => {
    setRow({
      activatedAt: null,
      stripeSubscriptionId: null,
      pilotUntil: null,
    })
    expect(await isCustomerPausedForBilling('sub_1')).toBe(false)
  })

  it('returns false: stripeSubscriptionId is set (subscribed)', async () => {
    setRow({
      activatedAt: new Date(),
      stripeSubscriptionId: 'sub_live_123',
      pilotUntil: null,
    })
    expect(await isCustomerPausedForBilling('sub_1')).toBe(false)
  })

  it('returns false: pilot active (pilotUntil > now)', async () => {
    setRow({
      activatedAt: new Date(),
      stripeSubscriptionId: null,
      pilotUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    expect(await isCustomerPausedForBilling('sub_1')).toBe(false)
  })

  it('returns true: pilot expired (pilotUntil in past)', async () => {
    setRow({
      activatedAt: new Date(),
      stripeSubscriptionId: null,
      pilotUntil: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    })
    expect(await isCustomerPausedForBilling('sub_1')).toBe(true)
  })

  it('returns false: subscriber row not found', async () => {
    setRow(null)
    expect(await isCustomerPausedForBilling('sub_nonexistent')).toBe(false)
  })
})

// Spec 53 — customer-keyed variant. Same predicate, different mock shape
// (no innerJoin). Used by the reengagement cron's batch pre-filter to
// avoid per-subscriber JOIN queries when we just need the answer for
// one customer.
describe('isCustomerPausedForBillingByCustomerId', () => {
  it('returns true: activatedAt set + no subscription + not on pilot', async () => {
    setCustomerRow({
      activatedAt: new Date(),
      stripeSubscriptionId: null,
      pilotUntil: null,
    })
    expect(await isCustomerPausedForBillingByCustomerId('cust_1')).toBe(true)
  })

  it('returns false: activatedAt is null', async () => {
    setCustomerRow({
      activatedAt: null,
      stripeSubscriptionId: null,
      pilotUntil: null,
    })
    expect(await isCustomerPausedForBillingByCustomerId('cust_1')).toBe(false)
  })

  it('returns false: subscribed', async () => {
    setCustomerRow({
      activatedAt: new Date(),
      stripeSubscriptionId: 'sub_active',
      pilotUntil: null,
    })
    expect(await isCustomerPausedForBillingByCustomerId('cust_1')).toBe(false)
  })

  it('returns false: pilot active', async () => {
    setCustomerRow({
      activatedAt: new Date(),
      stripeSubscriptionId: null,
      pilotUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    expect(await isCustomerPausedForBillingByCustomerId('cust_1')).toBe(false)
  })

  it('returns false: customer row not found', async () => {
    setCustomerRow(null)
    expect(await isCustomerPausedForBillingByCustomerId('cust_missing')).toBe(false)
  })
})

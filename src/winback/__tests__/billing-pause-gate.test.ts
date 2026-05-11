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

import { isCustomerPausedForBilling } from '../lib/email'

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

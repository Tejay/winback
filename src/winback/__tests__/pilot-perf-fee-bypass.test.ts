/**
 * Spec 31 — chargePerformanceFee pilot bypass.
 *
 * When `isCustomerOnPilot` is true:
 *   - returns { skipped: 'pilot', invoiceItemId: null, alreadyCharged: false }
 *   - emits performance_fee_skipped_pilot with skippedAmountCents
 *   - does NOT touch Stripe
 *   - does NOT mark perfFeeStripeItemId on the recovery (so a later retry
 *     after the pilot graduates can charge normally)
 *
 * When false: proceeds to the existing Stripe path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockIsCustomerOnPilot = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const mockGetPlatformStripe = vi.hoisted(() => vi.fn())
const mockInvoiceItemsCreate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers:          { id: 'c.id', stripePlatformCustomerId: 'c.spci', stripeSubscriptionId: 'c.ssid' },
  churnedSubscribers: { id: 'cs.id', email: 'cs.email' },
  recoveries:         { id: 'r.id', customerId: 'r.cid', subscriberId: 'r.sid', recoveryType: 'r.type', planMrrCents: 'r.mrr', perfFeeStripeItemId: 'r.pfsi', perfFeeAmountCents: 'r.pfa', perfFeeChargedAt: 'r.pfca', perfFeeRefundedAt: 'r.pfra' },
}))

vi.mock('drizzle-orm', () => ({
  eq:     vi.fn((a, b) => ({ eq: [a, b] })),
  and:    vi.fn((...a) => ({ and: a })),
  isNull: vi.fn((a) => ({ isNull: a })),
}))

vi.mock('../lib/platform-stripe', () => ({
  getPlatformStripe: mockGetPlatformStripe,
}))

vi.mock('../lib/subscription', () => ({
  PLATFORM_FEE_CURRENCY: 'usd',
}))

vi.mock('../lib/pilot', () => ({
  isCustomerOnPilot: mockIsCustomerOnPilot,
}))

vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { chargePerformanceFee } from '../lib/performance-fee'

beforeEach(() => {
  vi.clearAllMocks()
  mockGetPlatformStripe.mockReturnValue({
    invoiceItems: { create: mockInvoiceItemsCreate },
  })
  mockInvoiceItemsCreate.mockResolvedValue({ id: 'ii_1' })
})

function setupRecoverySelect(row: Record<string, unknown> | null) {
  mockSelect.mockImplementationOnce(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  }))
}

describe('chargePerformanceFee pilot bypass', () => {
  it('returns skipped:pilot when isCustomerOnPilot is true', async () => {
    setupRecoverySelect({
      id: 'rec_1', customerId: 'c1', subscriberId: 's1',
      recoveryType: 'win_back', planMrrCents: 4900,
      perfFeeStripeItemId: null,
    })
    mockIsCustomerOnPilot.mockResolvedValueOnce(true)

    const res = await chargePerformanceFee('rec_1')

    expect(res).toEqual({
      invoiceItemId: null,
      amountCents: 4900,
      alreadyCharged: false,
      skipped: 'pilot',
    })
    expect(mockInvoiceItemsCreate).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'performance_fee_skipped_pilot',
      customerId: 'c1',
      properties: expect.objectContaining({
        recoveryId: 'rec_1',
        skippedAmountCents: 4900,
      }),
    }))
  })

  it('proceeds to Stripe when isCustomerOnPilot is false', async () => {
    setupRecoverySelect({
      id: 'rec_1', customerId: 'c1', subscriberId: 's1',
      recoveryType: 'win_back', planMrrCents: 4900,
      perfFeeStripeItemId: null,
    })
    // Customer billing select (cust)
    mockSelect.mockImplementationOnce(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            stripePlatformCustomerId: 'cus_p_1',
            stripeSubscriptionId: 'sub_1',
          }]),
        }),
      }),
    }))
    // Subscriber email select
    mockSelect.mockImplementationOnce(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ email: 'sub@x.co' }]),
        }),
      }),
    }))
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    })

    mockIsCustomerOnPilot.mockResolvedValueOnce(false)

    const res = await chargePerformanceFee('rec_1')

    expect(res.skipped).toBeUndefined()
    expect(res.invoiceItemId).toBe('ii_1')
    expect(mockInvoiceItemsCreate).toHaveBeenCalledTimes(1)
  })

  it('returns alreadyCharged WITHOUT consulting the pilot gate when perfFeeStripeItemId is already set', async () => {
    setupRecoverySelect({
      id: 'rec_1', customerId: 'c1', subscriberId: 's1',
      recoveryType: 'win_back', planMrrCents: 4900,
      perfFeeStripeItemId: 'ii_existing',
    })

    const res = await chargePerformanceFee('rec_1')

    expect(res.alreadyCharged).toBe(true)
    expect(mockIsCustomerOnPilot).not.toHaveBeenCalled()
  })
})

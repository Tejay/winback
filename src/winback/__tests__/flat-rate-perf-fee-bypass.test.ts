/**
 * Spec 77 — chargePerformanceFee custom flat-rate bypass.
 *
 * Mirrors the pilot-bypass test (Spec 31). When a customer is on a
 * negotiated flat-rate deal:
 *   - returns { skipped: 'flat_rate', invoiceItemId: null, alreadyCharged: false }
 *   - emits performance_fee_skipped_flat_rate with skippedAmountCents
 *   - does NOT touch Stripe
 *   - does NOT mark perfFeeStripeItemId on the recovery
 *
 * Ordering: pilot wins over flat-rate when both apply.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockIsCustomerOnPilot = vi.hoisted(() => vi.fn())
const mockGetCustomMonthlyCents = vi.hoisted(() => vi.fn())
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
  or:     vi.fn((...a) => ({ or: a })),
  isNull: vi.fn((a) => ({ isNull: a })),
  lt:     vi.fn((a, b) => ({ lt: [a, b] })),
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

vi.mock('../lib/flat-rate', () => ({
  getCustomMonthlyCents: mockGetCustomMonthlyCents,
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

describe('chargePerformanceFee flat-rate bypass', () => {
  it('returns skipped:flat_rate when customer is on a flat-rate deal', async () => {
    setupRecoverySelect({
      id: 'rec_1', customerId: 'c1', subscriberId: 's1',
      recoveryType: 'win_back', planMrrCents: 4900,
      perfFeeStripeItemId: null,
    })
    mockIsCustomerOnPilot.mockResolvedValueOnce(false)
    mockGetCustomMonthlyCents.mockResolvedValueOnce(29900)  // $299/mo flat rate

    const res = await chargePerformanceFee('rec_1')

    expect(res).toEqual({
      invoiceItemId: null,
      amountCents: 4900,
      alreadyCharged: false,
      skipped: 'flat_rate',
    })
    expect(mockInvoiceItemsCreate).not.toHaveBeenCalled()
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'performance_fee_skipped_flat_rate',
      customerId: 'c1',
      properties: expect.objectContaining({
        recoveryId: 'rec_1',
        skippedAmountCents: 4900,
        customMonthlyCents: 29900,
      }),
    }))
  })

  it('pilot wins over flat-rate when both apply (pilot is free comp; flat-rate is paid)', async () => {
    setupRecoverySelect({
      id: 'rec_1', customerId: 'c1', subscriberId: 's1',
      recoveryType: 'win_back', planMrrCents: 4900,
      perfFeeStripeItemId: null,
    })
    mockIsCustomerOnPilot.mockResolvedValueOnce(true)
    // Note: even though getCustomMonthlyCents would have returned a value,
    // it should never be called because pilot short-circuits first.

    const res = await chargePerformanceFee('rec_1')

    expect(res.skipped).toBe('pilot')
    expect(mockGetCustomMonthlyCents).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'performance_fee_skipped_pilot',
    }))
  })

  it('proceeds to Stripe when customer is standard (no pilot, no flat-rate)', async () => {
    setupRecoverySelect({
      id: 'rec_1', customerId: 'c1', subscriberId: 's1',
      recoveryType: 'win_back', planMrrCents: 4900,
      perfFeeStripeItemId: null,
    })
    // Customer billing select
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
    // Spec 58 claim UPDATE — chainable .returning()
    mockUpdate.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const p: Promise<undefined> & { returning?: () => Promise<Array<{ id: string }>> } =
            Promise.resolve(undefined) as Promise<undefined> & {
              returning?: () => Promise<Array<{ id: string }>>
            }
          p.returning = () => Promise.resolve([{ id: 'rec_1' }])
          return p
        }),
      }),
    })

    mockIsCustomerOnPilot.mockResolvedValueOnce(false)
    mockGetCustomMonthlyCents.mockResolvedValueOnce(null)  // standard customer

    const res = await chargePerformanceFee('rec_1')

    expect(res.skipped).toBeUndefined()
    expect(res.invoiceItemId).toBe('ii_1')
    expect(mockInvoiceItemsCreate).toHaveBeenCalledTimes(1)
  })

  it('returns alreadyCharged WITHOUT consulting either gate when perfFeeStripeItemId is set', async () => {
    setupRecoverySelect({
      id: 'rec_1', customerId: 'c1', subscriberId: 's1',
      recoveryType: 'win_back', planMrrCents: 4900,
      perfFeeStripeItemId: 'ii_existing',
    })

    const res = await chargePerformanceFee('rec_1')

    expect(res.alreadyCharged).toBe(true)
    expect(mockIsCustomerOnPilot).not.toHaveBeenCalled()
    expect(mockGetCustomMonthlyCents).not.toHaveBeenCalled()
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())
const mockStripe = vi.hoisted(() => ({
  invoiceItems: {
    create: vi.fn(),
    retrieve: vi.fn(),
    del: vi.fn(),
  },
  invoices: {
    retrieve: vi.fn(),
  },
  creditNotes: {
    create: vi.fn(),
  },
}))

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: 'wb_customers',
  recoveries: 'wb_recoveries',
  churnedSubscribers: 'wb_churned_subscribers',
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
}))

vi.mock('../lib/platform-stripe', () => ({
  getPlatformStripe: () => mockStripe,
}))

const mockLogEvent = vi.hoisted(() => vi.fn())
vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

// Spec 31 — pilot bypass module added to performance-fee.ts. Stub to
// false so the existing tests flow through to the real Stripe path
// they're verifying.
vi.mock('../lib/pilot', () => ({
  isCustomerOnPilot: vi.fn().mockResolvedValue(false),
}))

import {
  chargePerformanceFee,
  refundPerformanceFee,
  chargePendingPerformanceFees,
} from '../lib/performance-fee'

interface RecRow {
  id: string
  subscriberId: string
  customerId: string
  planMrrCents: number
  recoveryType: string | null
  perfFeeStripeItemId: string | null
  perfFeeChargedAt: Date | null
  perfFeeRefundedAt: Date | null
}

interface CustRow {
  stripePlatformCustomerId: string | null
  stripeSubscriptionId: string | null
}

function setupReads(opts: {
  recovery?: RecRow | null
  customer?: CustRow | null
  subscriberEmail?: string
  pendingRecoveryIds?: string[]
}) {
  mockSelect.mockImplementation(() => ({
    from: (table: string) => {
      if (table === 'wb_recoveries') {
        // Two callers: loadRecovery (where + limit) and chargePendingPerformanceFees (where only)
        return {
          where: () => {
            if (opts.pendingRecoveryIds) {
              return opts.pendingRecoveryIds.map((id) => ({ id }))
            }
            return {
              limit: () => (opts.recovery === undefined ? [] : opts.recovery ? [opts.recovery] : []),
            }
          },
        }
      }
      if (table === 'wb_customers') {
        return {
          where: () => ({
            limit: () => (opts.customer === undefined ? [] : opts.customer ? [opts.customer] : []),
          }),
        }
      }
      if (table === 'wb_churned_subscribers') {
        return {
          where: () => ({
            limit: () => [{ email: opts.subscriberEmail ?? 'test@example.com' }],
          }),
        }
      }
      return { where: () => ({ limit: () => [] }) }
    },
  }))
}

function setupUpdateChain() {
  mockUpdate.mockImplementation(() => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
  }))
}

const baseRecovery: RecRow = {
  id: 'rec_1',
  subscriberId: 'sub_1',
  customerId: 'cust_1',
  planMrrCents: 2500,
  recoveryType: 'win_back',
  perfFeeStripeItemId: null,
  perfFeeChargedAt: null,
  perfFeeRefundedAt: null,
}

const baseCustomer: CustRow = {
  stripePlatformCustomerId: 'cus_platform_1',
  stripeSubscriptionId: 'sub_active_1',
}

describe('chargePerformanceFee', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateChain()
  })

  it('creates a Stripe invoice item and stores its id on the recovery', async () => {
    setupReads({ recovery: baseRecovery, customer: baseCustomer })
    mockStripe.invoiceItems.create.mockResolvedValue({ id: 'ii_new' })

    const result = await chargePerformanceFee('rec_1')

    expect(result.alreadyCharged).toBe(false)
    expect(result.invoiceItemId).toBe('ii_new')
    expect(result.amountCents).toBe(2500)
    expect(mockStripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_platform_1',
        subscription: 'sub_active_1',
        amount: 2500,
        currency: 'usd',
        metadata: expect.objectContaining({ winback_recovery_id: 'rec_1' }),
      }),
    )
    expect(mockUpdate).toHaveBeenCalled()
  })

  it('is idempotent when already charged', async () => {
    setupReads({
      recovery: { ...baseRecovery, perfFeeStripeItemId: 'ii_old' },
      customer: baseCustomer,
    })

    const result = await chargePerformanceFee('rec_1')

    expect(result.alreadyCharged).toBe(true)
    expect(result.invoiceItemId).toBe('ii_old')
    expect(mockStripe.invoiceItems.create).not.toHaveBeenCalled()
  })

  it('throws on a non-win-back recovery', async () => {
    setupReads({
      recovery: { ...baseRecovery, recoveryType: 'card_save' },
      customer: baseCustomer,
    })

    await expect(chargePerformanceFee('rec_1')).rejects.toThrow(/not a win-back/)
  })

  it('creates a pending invoice item (no subscription field) when no subscription exists yet', async () => {
    // This is the activation case: recovery → ensureActivation → charge first
    // (creates pending item) → ensurePlatformSubscription (Stripe bundles
    // pending items onto the first invoice).
    setupReads({
      recovery: baseRecovery,
      customer: { ...baseCustomer, stripeSubscriptionId: null },
    })
    mockStripe.invoiceItems.create.mockResolvedValue({ id: 'ii_pending' })

    const result = await chargePerformanceFee('rec_1')

    expect(result.invoiceItemId).toBe('ii_pending')
    expect(mockStripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ subscription: expect.anything() }),
    )
    expect(mockStripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_platform_1',
        amount: 2500,
      }),
    )
  })

  it('throws when recovery does not exist', async () => {
    setupReads({ recovery: null })
    await expect(chargePerformanceFee('rec_missing')).rejects.toThrow(/not found/)
  })
})

describe('refundPerformanceFee', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateChain()
  })

  it('deletes the invoice item when not yet attached to an invoice', async () => {
    setupReads({
      recovery: { ...baseRecovery, perfFeeStripeItemId: 'ii_pending' },
    })
    mockStripe.invoiceItems.retrieve.mockResolvedValue({
      id: 'ii_pending',
      invoice: null,
    })

    const result = await refundPerformanceFee('rec_1')

    expect(result.method).toBe('delete_item')
    expect(mockStripe.invoiceItems.del).toHaveBeenCalledWith('ii_pending')
    expect(mockStripe.creditNotes.create).not.toHaveBeenCalled()
  })

  it('deletes the invoice item when invoice is still draft', async () => {
    setupReads({
      recovery: { ...baseRecovery, perfFeeStripeItemId: 'ii_draft' },
    })
    mockStripe.invoiceItems.retrieve.mockResolvedValue({
      id: 'ii_draft',
      invoice: 'inv_draft',
    })
    mockStripe.invoices.retrieve.mockResolvedValue({
      id: 'inv_draft',
      status: 'draft',
      lines: { data: [] },
    })

    const result = await refundPerformanceFee('rec_1')

    expect(result.method).toBe('delete_item')
    expect(mockStripe.invoiceItems.del).toHaveBeenCalledWith('ii_draft')
  })

  it('issues a credit note when the invoice is finalized', async () => {
    setupReads({
      recovery: { ...baseRecovery, perfFeeStripeItemId: 'ii_paid' },
    })
    mockStripe.invoiceItems.retrieve.mockResolvedValue({
      id: 'ii_paid',
      invoice: 'inv_paid',
    })
    mockStripe.invoices.retrieve.mockResolvedValue({
      id: 'inv_paid',
      status: 'paid',
      lines: {
        data: [{ id: 'il_1', invoice_item: 'ii_paid' }],
      },
    })

    const result = await refundPerformanceFee('rec_1')

    expect(result.method).toBe('credit_note')
    expect(mockStripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({
        invoice: 'inv_paid',
        lines: [
          { type: 'invoice_line_item', invoice_line_item: 'il_1', quantity: 1 },
        ],
      }),
    )
    expect(mockStripe.invoiceItems.del).not.toHaveBeenCalled()
  })

  it('is idempotent when already refunded', async () => {
    setupReads({
      recovery: {
        ...baseRecovery,
        perfFeeStripeItemId: 'ii_x',
        perfFeeRefundedAt: new Date(),
      },
    })

    const result = await refundPerformanceFee('rec_1')

    expect(result.method).toBe('noop')
    expect(mockStripe.invoiceItems.retrieve).not.toHaveBeenCalled()
  })

  it('marks refunded with no Stripe call when there is no invoice item id', async () => {
    setupReads({ recovery: baseRecovery })

    const result = await refundPerformanceFee('rec_1')

    expect(result.method).toBe('noop')
    expect(mockStripe.invoiceItems.retrieve).not.toHaveBeenCalled()
    expect(mockUpdate).toHaveBeenCalled()
  })

  // Phase D — graceful no-line path. If Stripe's invoice expansion doesn't
  // include the matching line (paginated, manually edited, async lag), we
  // mark the recovery refunded locally and emit an admin event rather than
  // throwing into Stripe's webhook retry loop forever.
  it('marks refunded + emits event when finalized invoice has no matching line', async () => {
    setupReads({
      recovery: { ...baseRecovery, perfFeeStripeItemId: 'ii_orphan' },
    })
    mockStripe.invoiceItems.retrieve.mockResolvedValue({
      id: 'ii_orphan',
      invoice: 'inv_paid',
    })
    mockStripe.invoices.retrieve.mockResolvedValue({
      id: 'inv_paid',
      status: 'paid',
      lines: {
        data: [{ id: 'il_other', invoice_item: 'some_other_item' }],
      },
    })

    const result = await refundPerformanceFee('rec_1')

    expect(result.method).toBe('line_not_found')
    expect(mockStripe.creditNotes.create).not.toHaveBeenCalled()
    expect(mockStripe.invoiceItems.del).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'win_back_refund_line_missing',
        properties: expect.objectContaining({
          invoiceId: 'inv_paid',
          invoiceItemId: 'ii_orphan',
        }),
      }),
    )
    // Still marks refunded locally so we don't keep retrying.
    expect(mockUpdate).toHaveBeenCalled()
  })
})

describe('chargePendingPerformanceFees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateChain()
  })

  it('returns an empty list when there are no pending fees', async () => {
    setupReads({ pendingRecoveryIds: [] })
    const result = await chargePendingPerformanceFees('cust_1')
    expect(result.chargedRecoveryIds).toEqual([])
    expect(mockStripe.invoiceItems.create).not.toHaveBeenCalled()
  })

  // Integration coverage for the loop body (single-pending case) lives in
  // activation.test.ts where the full webhook path is exercised — the unit
  // value of repeating it here against a brittle multi-call mock is low.
})

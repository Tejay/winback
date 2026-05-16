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
  or: vi.fn((...args: unknown[]) => ({ op: 'or', args })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  lt: vi.fn((a, b) => ({ op: 'lt', a, b })),
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
  // Spec 78 — new columns surfaced by loadRecovery; tests can pre-set
  // perfFeeAmountCents or perfFeeBasisInvoiceId to exercise specific
  // refund / re-fire scenarios.
  perfFeeAmountCents: number | null
  perfFeeChargedAt: Date | null
  perfFeeRefundedAt: Date | null
  perfFeeBasisInvoiceId: string | null
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

/**
 * Spec 58 — the lock claim is `db.update(...).set(...).where(...).returning(...)`.
 * `.returning()` returns rows iff the WHERE matched. Pass `claimReturns` to
 * control whether the test caller "wins" the claim (default: wins).
 * Other UPDATE call sites (e.g. the final write of perfFeeStripeItemId)
 * don't use `.returning()` and just resolve to undefined.
 */
function setupUpdateChain(opts: { claimReturns?: Array<{ id: string }> } = {}) {
  const claimReturns = opts.claimReturns ?? [{ id: 'rec_1' }]
  mockUpdate.mockImplementation(() => ({
    set: () => ({
      where: () => {
        // Build a promise that ALSO has a .returning() method on it. Most
        // callers `await` the where(); the lock-claim caller calls
        // `.returning(...)` before awaiting.
        const p: Promise<undefined> & { returning?: () => Promise<unknown[]> } =
          Promise.resolve(undefined) as Promise<undefined> & {
            returning?: () => Promise<unknown[]>
          }
        p.returning = () => Promise.resolve(claimReturns)
        return p
      },
    }),
  }))
}

const baseRecovery: RecRow = {
  id: 'rec_1',
  subscriberId: 'sub_1',
  customerId: 'cust_1',
  planMrrCents: 2500,
  recoveryType: 'win_back',
  perfFeeStripeItemId: null,
  perfFeeAmountCents: null,
  perfFeeChargedAt: null,
  perfFeeRefundedAt: null,
  perfFeeBasisInvoiceId: null,
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
      expect.objectContaining({ idempotencyKey: 'wb-perf-rec_1' }),
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
      expect.objectContaining({ idempotencyKey: 'wb-perf-rec_1' }),
    )
    expect(mockStripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_platform_1',
        amount: 2500,
      }),
      expect.objectContaining({ idempotencyKey: 'wb-perf-rec_1' }),
    )
  })

  it('throws when recovery does not exist', async () => {
    setupReads({ recovery: null })
    await expect(chargePerformanceFee('rec_missing')).rejects.toThrow(/not found/)
  })

  // ============================================================
  // Spec 58 — race-fence + Stripe idempotency key
  // ============================================================

  it('Spec 58 — passes Idempotency-Key: wb-perf-${recoveryId} to Stripe', async () => {
    setupReads({ recovery: baseRecovery, customer: baseCustomer })
    mockStripe.invoiceItems.create.mockResolvedValue({ id: 'ii_new' })

    await chargePerformanceFee('rec_1')

    expect(mockStripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2500 }),
      { idempotencyKey: 'wb-perf-rec_1' },
    )
  })

  it('Spec 58 — claim lost, lock-holder finished → returns alreadyCharged', async () => {
    // First select returns the not-yet-charged recovery; chargePerformanceFee
    // proceeds to claim. The claim's UPDATE returns empty (someone else won).
    // The re-read finds perfFeeStripeItemId set (the winner wrote it).
    let selectCall = 0
    mockSelect.mockImplementation(() => ({
      from: (table: string) => ({
        where: () => ({
          limit: () => {
            if (table === 'wb_recoveries') {
              selectCall += 1
              return selectCall === 1
                ? [baseRecovery]                                // initial loadRecovery
                : [{ ...baseRecovery, perfFeeStripeItemId: 'ii_winner' }]  // re-read after claim loss
            }
            if (table === 'wb_customers') return [baseCustomer]
            if (table === 'wb_churned_subscribers') return [{ email: 't@x.com' }]
            return []
          },
        }),
      }),
    }))
    setupUpdateChain({ claimReturns: [] }) // claim returns no row → lost the race

    const result = await chargePerformanceFee('rec_1')

    expect(result.alreadyCharged).toBe(true)
    expect(result.invoiceItemId).toBe('ii_winner')
    expect(mockStripe.invoiceItems.create).not.toHaveBeenCalled()
  })

  it('Spec 58 — claim lost, holder still mid-create → returns skipped=race, NO Stripe call', async () => {
    // Both selects (initial + re-read) return the recovery still unfired.
    // This is the in-flight state: a lock-holder is between Stripe POST
    // and DB UPDATE. We back out cleanly — the holder will finish.
    setupReads({ recovery: baseRecovery, customer: baseCustomer })
    setupUpdateChain({ claimReturns: [] })

    const result = await chargePerformanceFee('rec_1')

    expect(result.alreadyCharged).toBe(false)
    expect(result.skipped).toBe('race')
    expect(result.invoiceItemId).toBeNull()
    expect(mockStripe.invoiceItems.create).not.toHaveBeenCalled()
    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'perf_fee_create_skipped_race' }),
    )
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
        // Spec 61 — must include refund_amount so the credit note's total balances
        refund_amount: 2500,
      }),
    )
    expect(mockStripe.invoiceItems.del).not.toHaveBeenCalled()
  })

  // Spec 61 — Stripe API ≥ 2024-09-30 shape. The invoice_item moved from
  // line.invoice_item to line.parent.invoice_item_details.invoice_item.
  // This is the shape we actually receive in production today.
  it('creates a credit note on new-API invoice shape (Spec 61)', async () => {
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
        data: [{
          id: 'il_1',
          // No top-level invoice_item on new shape — it's nested under parent.
          parent: {
            type: 'invoice_item_details',
            invoice_item_details: { invoice_item: 'ii_paid' },
          },
        }],
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
        // Spec 61 — must include refund_amount so the credit note's total balances
        refund_amount: 2500,
      }),
    )
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

// --------------------------------------------------------------------------
// Spec 78 — deferred firing model
// --------------------------------------------------------------------------
describe('chargePerformanceFee — Spec 78 deferred firing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateChain()
  })

  it('uses opts.amountCents instead of planMrrCents when provided', async () => {
    setupReads({ recovery: baseRecovery, customer: baseCustomer })
    mockStripe.invoiceItems.create.mockResolvedValue({ id: 'ii_new' })

    const result = await chargePerformanceFee('rec_1', {
      amountCents: 12000,                        // ≠ planMrrCents (2500)
      basisInvoiceId: 'in_test_basis_001',
    })

    expect(result.amountCents).toBe(12000)
    expect(mockStripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 12000,                            // not 2500
        metadata: expect.objectContaining({
          winback_basis_invoice_id: 'in_test_basis_001',
        }),
      }),
      // basis-invoice id added to Stripe Idempotency-Key
      expect.objectContaining({
        idempotencyKey: 'wb-perf-rec_1-in_test_basis_001',
      }),
    )
  })

  it('falls back to planMrrCents when opts is omitted (legacy path)', async () => {
    setupReads({ recovery: baseRecovery, customer: baseCustomer })
    mockStripe.invoiceItems.create.mockResolvedValue({ id: 'ii_new' })

    const result = await chargePerformanceFee('rec_1')

    expect(result.amountCents).toBe(2500)
    expect(mockStripe.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 2500 }),
      expect.objectContaining({ idempotencyKey: 'wb-perf-rec_1' }),
    )
  })

  it('returns alreadyCharged with the persisted amount (perfFeeAmountCents) on retry', async () => {
    setupReads({
      recovery: {
        ...baseRecovery,
        perfFeeStripeItemId: 'ii_existing',
        perfFeeAmountCents: 8800,            // basis invoice was $88
      },
      customer: baseCustomer,
    })

    const result = await chargePerformanceFee('rec_1', { amountCents: 9999 })

    // Persisted amount wins — we don't re-bill at a different price even
    // if the caller asks for one.
    expect(result.amountCents).toBe(8800)
    expect(result.alreadyCharged).toBe(true)
    expect(mockStripe.invoiceItems.create).not.toHaveBeenCalled()
  })
})

describe('refundPerformanceFee — Spec 78 refund amount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateChain()
  })

  it('credit-notes perfFeeAmountCents not planMrrCents', async () => {
    setupReads({
      recovery: {
        ...baseRecovery,
        perfFeeStripeItemId: 'ii_existing',
        perfFeeAmountCents: 5000,            // we charged $50
        perfFeeChargedAt: new Date(),
      },
      customer: baseCustomer,
    })
    mockStripe.invoiceItems.retrieve.mockResolvedValue({
      id: 'ii_existing',
      invoice: 'in_finalized',
    })
    mockStripe.invoices.retrieve.mockResolvedValue({
      id: 'in_finalized',
      status: 'paid',
      lines: { data: [{ id: 'il_1', invoice_item: 'ii_existing' }] },
    })

    await refundPerformanceFee('rec_1')

    expect(mockStripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({ refund_amount: 5000 }),   // not 2500
    )
  })

  it('falls back to planMrrCents when perfFeeAmountCents is null (pre-spec-78 row)', async () => {
    setupReads({
      recovery: {
        ...baseRecovery,
        perfFeeStripeItemId: 'ii_legacy',
        perfFeeAmountCents: null,            // legacy row predates spec 78
        perfFeeChargedAt: new Date(),
      },
      customer: baseCustomer,
    })
    mockStripe.invoiceItems.retrieve.mockResolvedValue({
      id: 'ii_legacy',
      invoice: 'in_finalized',
    })
    mockStripe.invoices.retrieve.mockResolvedValue({
      id: 'in_finalized',
      status: 'paid',
      lines: { data: [{ id: 'il_1', invoice_item: 'ii_legacy' }] },
    })

    await refundPerformanceFee('rec_1')

    expect(mockStripe.creditNotes.create).toHaveBeenCalledWith(
      expect.objectContaining({ refund_amount: 2500 }),
    )
  })
})

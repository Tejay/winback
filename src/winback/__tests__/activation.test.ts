import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: 'wb_customers',
  recoveries: 'wb_recoveries',
  // Spec 51 — activation now joins recoveries with churned_subscribers
  // to pull the recovered subscriber's name for the trial-complete email.
  churnedSubscribers: 'wb_churned_subscribers',
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
  desc: vi.fn((a) => ({ op: 'desc', a })),
}))

const mockGetOrCreatePlatformCustomer = vi.hoisted(() =>
  vi.fn(async () => 'cus_platform'),
)
const mockGetCurrentDefaultPaymentMethodId = vi.hoisted(() => vi.fn())

vi.mock('../lib/platform-billing', () => ({
  getOrCreatePlatformCustomer: mockGetOrCreatePlatformCustomer,
  getCurrentDefaultPaymentMethodId: mockGetCurrentDefaultPaymentMethodId,
}))

const mockEnsurePlatformSubscription = vi.hoisted(() => vi.fn())
vi.mock('../lib/subscription', () => ({
  ensurePlatformSubscription: mockEnsurePlatformSubscription,
}))

// Spec 78 — activation no longer calls chargePendingPerformanceFees.
// The performance fee fires from the Connect-side invoice.payment_succeeded
// webhook when the recovered subscriber's first non-zero invoice settles.
// We keep an empty mock of the module so the import surface is satisfied,
// but no functions are referenced from activation.ts anymore.

const mockLogEvent = vi.hoisted(() => vi.fn())
vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

// Spec 31 — pilot bypass module added to activation.ts. Tests in this
// file pre-date Spec 31 and assume normal billing, so we stub
// isCustomerOnPilot to false and let ensureActivation flow through.
vi.mock('../lib/pilot', () => ({
  isCustomerOnPilot: vi.fn().mockResolvedValue(false),
  getPilotUntil:     vi.fn().mockResolvedValue(null),
}))

// Spec 51 — activation now sends a trial-complete email when activatedAt
// is first set. Stub the sender as a no-op for these tests.
vi.mock('../lib/billing-notifications', () => ({
  sendPlatformTrialCompleteEmail: vi.fn().mockResolvedValue(undefined),
}))

import { ensureActivation } from '../lib/activation'

interface CustRow {
  id: string
  stripePlatformCustomerId: string | null
  stripeSubscriptionId: string | null
  activatedAt: Date | null
}

function setupReads(opts: {
  customer: CustRow | null
  hasDelivery: boolean
}) {
  mockSelect.mockImplementation(() => ({
    from: (table: string) => {
      if (table === 'wb_customers') {
        return {
          where: () => ({
            limit: () => (opts.customer ? [opts.customer] : []),
          }),
        }
      }
      if (table === 'wb_recoveries') {
        return {
          where: () => ({
            limit: () => (opts.hasDelivery ? [{ id: 'rec_x' }] : []),
          }),
          // Spec 51 — activation joins recoveries → churned_subscribers
          // to pull the recovered subscriber's name for the trial-complete email.
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => (opts.hasDelivery ? [{ name: 'Sarah Lee', mrrCents: 5000 }] : []),
              }),
            }),
          }),
        }
      }
      return { where: () => ({ limit: () => [] }) }
    },
  }))
}

/**
 * Default chain: .update().set().where(...).returning(...) returns one row
 * (the conditional UPDATE in ensureActivation succeeded). Tests can override
 * this for the lost-the-race case.
 */
function setupUpdateChain(opts: { wonRace?: boolean } = {}) {
  const wonRace = opts.wonRace ?? true
  mockUpdate.mockImplementation(() => ({
    set: () => {
      const whereResult: Promise<undefined> & {
        returning: () => Promise<Array<{ activatedAt: Date }>>
      } = Promise.resolve(undefined) as Promise<undefined> & {
        returning: () => Promise<Array<{ activatedAt: Date }>>
      }
      whereResult.returning = async () =>
        wonRace ? [{ activatedAt: new Date('2026-04-27T00:00:00Z') }] : []
      return {
        where: () => whereResult,
      }
    },
  }))
}

const baseCustomer: CustRow = {
  id: 'cust_1',
  stripePlatformCustomerId: 'cus_platform',
  stripeSubscriptionId: null,
  activatedAt: null,
}

describe('ensureActivation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupUpdateChain()
  })

  it('returns no_op when no recoveries have been delivered yet', async () => {
    setupReads({ customer: baseCustomer, hasDelivery: false })

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('no_op')
    expect(mockGetCurrentDefaultPaymentMethodId).not.toHaveBeenCalled()
    expect(mockEnsurePlatformSubscription).not.toHaveBeenCalled()
  })

  it('first delivery without a card → awaiting_card and sets activated_at', async () => {
    setupReads({ customer: baseCustomer, hasDelivery: true })
    mockGetCurrentDefaultPaymentMethodId.mockResolvedValue(null)

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('awaiting_card')
    expect(mockUpdate).toHaveBeenCalled()  // activated_at write
    expect(mockEnsurePlatformSubscription).not.toHaveBeenCalled()
  })

  // Spec 78 — activation creates the platform subscription but does NOT
  // charge any perf fees. Fees fire from the invoice.payment_succeeded
  // webhook when the recovered subscriber pays their first non-zero
  // invoice.
  it('first delivery with a card on file → active, creates subscription, no fees charged yet', async () => {
    setupReads({ customer: baseCustomer, hasDelivery: true })
    mockGetCurrentDefaultPaymentMethodId.mockResolvedValue('pm_card')
    mockEnsurePlatformSubscription.mockResolvedValue({
      subscriptionId: 'sub_new',
      created: true,
    })

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('active')
    if (result.state === 'active') {
      expect(result.subscriptionId).toBe('sub_new')
      expect(result.subscriptionCreated).toBe(true)
      expect(result.chargedRecoveryIds).toEqual([])
    }
    expect(mockEnsurePlatformSubscription).toHaveBeenCalledWith('cust_1')
  })

  it('already activated, still no card → awaiting_card with no extra DB write', async () => {
    const alreadyActivated: CustRow = {
      ...baseCustomer,
      activatedAt: new Date('2026-04-01'),
    }
    setupReads({ customer: alreadyActivated, hasDelivery: true })
    mockGetCurrentDefaultPaymentMethodId.mockResolvedValue(null)

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('awaiting_card')
    if (result.state === 'awaiting_card') {
      expect(result.activatedAt.toISOString()).toBe('2026-04-01T00:00:00.000Z')
    }
    expect(mockUpdate).not.toHaveBeenCalled()  // already set, no rewrite
  })

  // Spec 78 — activation creates the subscription; perf fees fire later
  // via the Connect-side invoice.payment_succeeded webhook.
  it('already activated, card lands later → creates sub, no fees charged at activation', async () => {
    const alreadyActivated: CustRow = {
      ...baseCustomer,
      activatedAt: new Date('2026-04-01'),
    }
    setupReads({ customer: alreadyActivated, hasDelivery: true })
    mockGetCurrentDefaultPaymentMethodId.mockResolvedValue('pm_card')
    mockEnsurePlatformSubscription.mockResolvedValue({
      subscriptionId: 'sub_new',
      created: true,
    })

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('active')
    if (result.state === 'active') {
      expect(result.chargedRecoveryIds).toEqual([])
    }
  })

  it('subscription exists → still active, no fees charged at activation', async () => {
    const fullyActive: CustRow = {
      ...baseCustomer,
      activatedAt: new Date('2026-04-01'),
      stripeSubscriptionId: 'sub_existing',
    }
    setupReads({ customer: fullyActive, hasDelivery: true })
    mockGetCurrentDefaultPaymentMethodId.mockResolvedValue('pm_card')
    mockEnsurePlatformSubscription.mockResolvedValue({
      subscriptionId: 'sub_existing',
      created: false,
    })

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('active')
    if (result.state === 'active') {
      expect(result.subscriptionCreated).toBe(false)
      expect(result.chargedRecoveryIds).toEqual([])
    }
  })

  // Phase D — race condition: two ensureActivation calls land at once. The
  // second call's conditional UPDATE returns no rows; we re-read the
  // customer row to pick up the timestamp the first call wrote.
  it('lost the activatedAt race → re-reads customer row to get the winning timestamp', async () => {
    const racedTimestamp = new Date('2026-04-27T10:00:00Z')
    let customerReadCount = 0
    mockSelect.mockImplementation(() => ({
      from: (table: string) => {
        if (table === 'wb_customers') {
          return {
            where: () => ({
              limit: () => {
                customerReadCount++
                // First read: activatedAt is null (we haven't claimed yet).
                // Second read (after losing the race): the winning call's
                // timestamp is now visible.
                return customerReadCount === 1
                  ? [baseCustomer]
                  : [{ ...baseCustomer, activatedAt: racedTimestamp }]
              },
            }),
          }
        }
        if (table === 'wb_recoveries') {
          return { where: () => ({ limit: () => [{ id: 'rec_x' }] }) }
        }
        return { where: () => ({ limit: () => [] }) }
      },
    }))
    setupUpdateChain({ wonRace: false }) // .returning() yields []
    mockGetCurrentDefaultPaymentMethodId.mockResolvedValue(null)

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('awaiting_card')
    if (result.state === 'awaiting_card') {
      expect(result.activatedAt).toEqual(racedTimestamp)
    }
    expect(customerReadCount).toBe(2) // initial + post-race re-read
  })

  it('throws when wb_customer not found', async () => {
    setupReads({ customer: null, hasDelivery: false })
    await expect(ensureActivation('cust_missing')).rejects.toThrow(/not found/)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers: 'wb_customers',
  recoveries: 'wb_recoveries',
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((a, b) => ({ op: 'eq', a, b })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  isNull: vi.fn((a) => ({ op: 'isNull', a })),
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

const mockChargePendingPerformanceFees = vi.hoisted(() => vi.fn())
vi.mock('../lib/performance-fee', () => ({
  chargePendingPerformanceFees: mockChargePendingPerformanceFees,
}))

const mockLogEvent = vi.hoisted(() => vi.fn())
vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
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
    expect(mockChargePendingPerformanceFees).not.toHaveBeenCalled()
  })

  it('first delivery with a card on file → active, creates subscription, drains pending fees', async () => {
    setupReads({ customer: baseCustomer, hasDelivery: true })
    mockGetCurrentDefaultPaymentMethodId.mockResolvedValue('pm_card')
    mockEnsurePlatformSubscription.mockResolvedValue({
      subscriptionId: 'sub_new',
      created: true,
    })
    mockChargePendingPerformanceFees.mockResolvedValue({
      chargedRecoveryIds: ['rec_x'],
    })

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('active')
    if (result.state === 'active') {
      expect(result.subscriptionId).toBe('sub_new')
      expect(result.subscriptionCreated).toBe(true)
      expect(result.chargedRecoveryIds).toEqual(['rec_x'])
    }
    expect(mockEnsurePlatformSubscription).toHaveBeenCalledWith('cust_1')
    expect(mockChargePendingPerformanceFees).toHaveBeenCalledWith('cust_1')
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

  it('already activated, card lands later → creates sub and drains pending', async () => {
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
    mockChargePendingPerformanceFees.mockResolvedValue({
      chargedRecoveryIds: ['rec_a', 'rec_b'],
    })

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('active')
    if (result.state === 'active') {
      expect(result.chargedRecoveryIds).toEqual(['rec_a', 'rec_b'])
    }
  })

  it('subscription exists, only new pending perf fees → drains them', async () => {
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
    mockChargePendingPerformanceFees.mockResolvedValue({
      chargedRecoveryIds: ['rec_new'],
    })

    const result = await ensureActivation('cust_1')

    expect(result.state).toBe('active')
    if (result.state === 'active') {
      expect(result.subscriptionCreated).toBe(false)
      expect(result.chargedRecoveryIds).toEqual(['rec_new'])
    }
  })

  // Phase D — self-heal visibility test.
  it('self-heal: emits activation_self_heal event when an already-active customer drains queued fees', async () => {
    const alreadyActive: CustRow = {
      ...baseCustomer,
      activatedAt: new Date('2026-04-01'),
      stripeSubscriptionId: 'sub_existing',
    }
    setupReads({ customer: alreadyActive, hasDelivery: true })
    mockGetCurrentDefaultPaymentMethodId.mockResolvedValue('pm_card')
    mockEnsurePlatformSubscription.mockResolvedValue({
      subscriptionId: 'sub_existing',
      created: false,
    })
    mockChargePendingPerformanceFees.mockResolvedValue({
      chargedRecoveryIds: ['rec_stuck_1', 'rec_stuck_2'],
    })

    await ensureActivation('cust_1')

    expect(mockLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'activation_self_heal',
        customerId: 'cust_1',
        properties: expect.objectContaining({
          drainedCount: 2,
          recoveryIds: ['rec_stuck_1', 'rec_stuck_2'],
        }),
      }),
    )
  })

  // Phase D — first activation should NOT emit the self-heal event (the
  // initial drain is part of the normal first-cycle flow, not a recovery
  // from a stuck state).
  it('first activation does not emit activation_self_heal', async () => {
    setupReads({ customer: baseCustomer, hasDelivery: true })
    mockGetCurrentDefaultPaymentMethodId.mockResolvedValue('pm_card')
    mockEnsurePlatformSubscription.mockResolvedValue({
      subscriptionId: 'sub_new',
      created: true,
    })
    mockChargePendingPerformanceFees.mockResolvedValue({
      chargedRecoveryIds: ['rec_first'],
    })

    await ensureActivation('cust_1')

    const selfHealCalls = mockLogEvent.mock.calls.filter(
      ([arg]) => arg?.name === 'activation_self_heal',
    )
    expect(selfHealCalls).toHaveLength(0)
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

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

function setupUpdateChain() {
  mockUpdate.mockImplementation(() => ({
    set: () => ({ where: () => Promise.resolve(undefined) }),
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

  it('throws when wb_customer not found', async () => {
    setupReads({ customer: null, hasDelivery: false })
    await expect(ensureActivation('cust_missing')).rejects.toThrow(/not found/)
  })
})

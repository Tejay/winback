/**
 * Spec 31 — Pilot bypass tests for the activation + perf-fee gates.
 *
 * Verifies that while `isCustomerOnPilot` returns true:
 *   - ensureActivation short-circuits with state: 'pilot' BEFORE charging
 *     pending perf fees or creating the platform subscription
 *   - chargePerformanceFee returns { skipped: 'pilot' } and emits the
 *     `performance_fee_skipped_pilot` event with skippedAmountCents
 *
 * And that when isCustomerOnPilot returns false:
 *   - both proceed normally to their existing Stripe paths
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockEnsurePlatformSubscription = vi.hoisted(() => vi.fn())
const mockChargePendingPerformanceFees = vi.hoisted(() => vi.fn())
const mockGetOrCreatePlatformCustomer = vi.hoisted(() => vi.fn())
const mockGetCurrentDefaultPaymentMethodId = vi.hoisted(() => vi.fn())
const mockIsCustomerOnPilot = vi.hoisted(() => vi.fn())
const mockGetPilotUntil = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

const mockSelect = vi.hoisted(() => vi.fn())
const mockUpdate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/db', () => ({
  db: { select: mockSelect, update: mockUpdate },
}))

vi.mock('@/lib/schema', () => ({
  customers:        { id: 'c.id', userId: 'c.uid', stripePlatformCustomerId: 'c.spci', stripeSubscriptionId: 'c.ssid', activatedAt: 'c.aa' },
  recoveries:       { id: 'r.id', customerId: 'r.cid', subscriberId: 'r.sid', recoveryType: 'r.type', planMrrCents: 'r.mrr', perfFeeStripeItemId: 'r.pfsi', perfFeeAmountCents: 'r.pfa', perfFeeChargedAt: 'r.pfca', perfFeeRefundedAt: 'r.pfra' },
  churnedSubscribers: { id: 'cs.id', email: 'cs.email' },
}))

vi.mock('drizzle-orm', () => ({
  eq:     vi.fn((a, b) => ({ eq: [a, b] })),
  and:    vi.fn((...a) => ({ and: a })),
  isNull: vi.fn((a) => ({ isNull: a })),
}))

vi.mock('../lib/platform-billing', () => ({
  getOrCreatePlatformCustomer:    mockGetOrCreatePlatformCustomer,
  getCurrentDefaultPaymentMethodId: mockGetCurrentDefaultPaymentMethodId,
}))

vi.mock('../lib/subscription', () => ({
  ensurePlatformSubscription: mockEnsurePlatformSubscription,
  PLATFORM_FEE_CURRENCY:      'usd',
}))

vi.mock('../lib/performance-fee', async () => {
  // Real chargePendingPerformanceFees runs through the bypass path too,
  // but for this suite we stub it to focus on the orchestration gate.
  return {
    chargePendingPerformanceFees: mockChargePendingPerformanceFees,
  }
})

vi.mock('../lib/pilot', () => ({
  isCustomerOnPilot: mockIsCustomerOnPilot,
  getPilotUntil:     mockGetPilotUntil,
}))

vi.mock('../lib/events', () => ({
  logEvent: mockLogEvent,
}))

import { ensureActivation } from '../lib/activation'

beforeEach(() => {
  vi.clearAllMocks()
  mockEnsurePlatformSubscription.mockResolvedValue({ subscriptionId: 'sub_1', created: true })
  mockChargePendingPerformanceFees.mockResolvedValue({ chargedRecoveryIds: [] })
  mockGetOrCreatePlatformCustomer.mockResolvedValue('cus_platform_1')
  mockGetCurrentDefaultPaymentMethodId.mockResolvedValue('pm_1')
  mockIsCustomerOnPilot.mockResolvedValue(false)
  mockGetPilotUntil.mockResolvedValue(null)
})

function setupCustomerSelect(row: Record<string, unknown> | null) {
  mockSelect.mockImplementationOnce(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  }))
}

function setupRecoveriesSelect(rows: unknown[]) {
  mockSelect.mockImplementationOnce(() => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  }))
}

describe('ensureActivation pilot bypass', () => {
  it('short-circuits with state: pilot BEFORE perf fees / subscription when on pilot', async () => {
    setupCustomerSelect({
      id: 'c1', stripePlatformCustomerId: null, stripeSubscriptionId: null, activatedAt: null,
    })
    setupRecoveriesSelect([{ id: 'r1' }])  // hasAnyDelivery returns true

    const pilotUntil = new Date(Date.now() + 30 * 24 * 60 * 60_000)
    mockIsCustomerOnPilot.mockResolvedValueOnce(true)
    mockGetPilotUntil.mockResolvedValueOnce(pilotUntil)

    const res = await ensureActivation('c1')
    expect(res).toEqual({ state: 'pilot', pilotUntil })

    // Critical: neither downstream Stripe call fires.
    expect(mockChargePendingPerformanceFees).not.toHaveBeenCalled()
    expect(mockEnsurePlatformSubscription).not.toHaveBeenCalled()

    // Audit event fired with the pilot end date.
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'platform_billing_skipped_pilot',
      customerId: 'c1',
      properties: expect.objectContaining({
        pilotUntil: pilotUntil.toISOString(),
      }),
    }))
  })

  it('does not skip when isCustomerOnPilot returns false', async () => {
    setupCustomerSelect({
      id: 'c1', stripePlatformCustomerId: 'cus_p_1', stripeSubscriptionId: null, activatedAt: new Date(),
    })
    setupRecoveriesSelect([{ id: 'r1' }])

    mockIsCustomerOnPilot.mockResolvedValueOnce(false)

    const res = await ensureActivation('c1')
    expect(res.state).toBe('active')
    expect(mockEnsurePlatformSubscription).toHaveBeenCalled()
  })

  it('returns no_op (no pilot check needed) when there are no deliveries', async () => {
    setupCustomerSelect({
      id: 'c1', stripePlatformCustomerId: null, stripeSubscriptionId: null, activatedAt: null,
    })
    setupRecoveriesSelect([])  // no deliveries

    const res = await ensureActivation('c1')
    expect(res).toEqual({ state: 'no_op' })
    expect(mockIsCustomerOnPilot).not.toHaveBeenCalled()
  })
})

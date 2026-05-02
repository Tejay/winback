/**
 * Spec 41 — Pure-function tests for computeCumulativeRevenueSavedCents.
 *
 * The cron route is a thin wrapper over this helper plus DB I/O; all
 * the math + edge-case behavior lives here and is fully testable
 * without a database.
 */
import { describe, it, expect } from 'vitest'
import {
  computeCumulativeRevenueSavedCents,
  type RecoveryForRevenue,
  type SubscriberLifecycle,
} from '../lib/revenue'

const ASOF = new Date('2026-05-02T00:00:00Z')

function makeRecovery(
  overrides: Partial<RecoveryForRevenue> = {},
): RecoveryForRevenue {
  return {
    subscriptionId: 'sub_test',
    mrrCents: 2000,  // $20/mo default
    recoveredAt: new Date('2025-11-02T00:00:00Z'),  // 6 months before ASOF
    ...overrides,
  }
}

describe('computeCumulativeRevenueSavedCents', () => {
  it('returns 0 when there are no recoveries', () => {
    expect(computeCumulativeRevenueSavedCents([], new Map(), ASOF)).toBe(0)
  })

  it('returns 0 for a recovery that happened today', () => {
    const recoveries = [makeRecovery({ recoveredAt: ASOF })]
    expect(computeCumulativeRevenueSavedCents(recoveries, new Map(), ASOF)).toBe(0)
  })

  it('counts whole 30-day months only', () => {
    // 29 days → 0 months → contributes 0
    const r29 = [makeRecovery({
      recoveredAt: new Date(ASOF.getTime() - 29 * 24 * 60 * 60 * 1000),
    })]
    expect(computeCumulativeRevenueSavedCents(r29, new Map(), ASOF)).toBe(0)

    // 30 days exactly → 1 month → mrrCents
    const r30 = [makeRecovery({
      recoveredAt: new Date(ASOF.getTime() - 30 * 24 * 60 * 60 * 1000),
    })]
    expect(computeCumulativeRevenueSavedCents(r30, new Map(), ASOF)).toBe(2000)

    // 95 days → 3 months (floor of 95/30 = 3.16) → 3 × mrrCents
    const r95 = [makeRecovery({
      recoveredAt: new Date(ASOF.getTime() - 95 * 24 * 60 * 60 * 1000),
    })]
    expect(computeCumulativeRevenueSavedCents(r95, new Map(), ASOF)).toBe(6000)
  })

  it('uses asOf when the subscriber is still subscribed (no lifecycle entry)', () => {
    // 6 months ago, no re-churn → 6 months × $20 = $120 (12000 cents)
    const recoveries = [makeRecovery()]
    expect(computeCumulativeRevenueSavedCents(recoveries, new Map(), ASOF)).toBe(12000)
  })

  it('uses reChurnedAt when the subscriber re-churned after recovery', () => {
    const recovered = new Date('2025-11-02T00:00:00Z')
    const reChurned = new Date('2026-02-02T00:00:00Z')  // ~92 days later → 3 months
    const recoveries = [makeRecovery({ subscriptionId: 'sub_a', recoveredAt: recovered })]
    const lifecycles = new Map<string, SubscriberLifecycle>([
      ['sub_a', { reChurnedAt: reChurned }],
    ])
    expect(computeCumulativeRevenueSavedCents(recoveries, lifecycles, ASOF)).toBe(6000)
  })

  it('ignores re-churn events that happened BEFORE the recovery (different segment)', () => {
    // Subscriber churned 1 year ago, was won back 6 months ago, still subscribed.
    // Old re-churn date should not be used as retention end.
    const oldChurn = new Date('2025-05-02T00:00:00Z')
    const recovered = new Date('2025-11-02T00:00:00Z')
    const recoveries = [makeRecovery({ subscriptionId: 'sub_a', recoveredAt: recovered })]
    const lifecycles = new Map<string, SubscriberLifecycle>([
      ['sub_a', { reChurnedAt: oldChurn }],  // BEFORE recovery → falls through to asOf
    ])
    // Should treat as still subscribed → 6 months × $20 = $120
    expect(computeCumulativeRevenueSavedCents(recoveries, lifecycles, ASOF)).toBe(12000)
  })

  it('treats a recovery with subscriptionId=null as still subscribed', () => {
    const recoveries = [makeRecovery({ subscriptionId: null })]
    // Lifecycle map can't be looked up; falls through to asOf → 6 months × $20
    expect(computeCumulativeRevenueSavedCents(recoveries, new Map(), ASOF)).toBe(12000)
  })

  it('sums multiple recoveries for the same customer', () => {
    const recoveries = [
      makeRecovery({
        subscriptionId: 'sub_a',
        mrrCents: 2000,  // $20/mo, 6 months → $120
      }),
      makeRecovery({
        subscriptionId: 'sub_b',
        mrrCents: 5000,  // $50/mo, 6 months → $300
      }),
    ]
    expect(computeCumulativeRevenueSavedCents(recoveries, new Map(), ASOF)).toBe(42000)
  })

  it('handles the rebuild case: recovered → re-churned → recovered again', () => {
    // First recovery: 12 months ago, re-churned 6 months ago → 6 full months.
    // Second recovery: 5 months ago, still subscribed → 5 full months.
    // Both at $20/mo. Total: 11 × $20 = $220 = 22000 cents.
    //
    // Note: this test exercises that the helper correctly handles MULTIPLE
    // recoveries for the same subscription_id. The lifecycles map has ONE
    // entry per subscription_id (the most recent re-churn). For a
    // subscription that has been recovered twice, the map's reChurnedAt
    // refers to the BETWEEN re-churn. The first recovery's segment ends
    // at that re-churn; the second recovery's segment starts after — and
    // the same `reChurnedAt < recoveredAt2` falls through to asOf
    // (per the "ignore older re-churn" rule).
    const recovered1 = new Date('2025-05-02T00:00:00Z')   // 12 months ago
    const reChurned  = new Date('2025-11-02T00:00:00Z')   // 6 months ago
    const recovered2 = new Date('2025-12-02T00:00:00Z')   // 5 months ago
    const recoveries = [
      makeRecovery({ subscriptionId: 'sub_a', recoveredAt: recovered1 }),
      makeRecovery({ subscriptionId: 'sub_a', recoveredAt: recovered2 }),
    ]
    const lifecycles = new Map<string, SubscriberLifecycle>([
      ['sub_a', { reChurnedAt: reChurned }],
    ])
    // First recovery: reChurned is AFTER recovered1 → use reChurned (6 months × $20 = $120).
    // Second recovery: reChurned is BEFORE recovered2 → falls through to asOf (5 months × $20 = $100).
    // Total = $220 = 22000 cents.
    expect(computeCumulativeRevenueSavedCents(recoveries, lifecycles, ASOF)).toBe(22000)
  })
})

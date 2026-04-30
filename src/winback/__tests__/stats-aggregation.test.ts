/**
 * Spec 39 — Pure-function tests for the dashboard stats aggregation.
 *
 * Covers the type/window bucketing reducer and the recovery-rate
 * calculation. The /api/stats route is a thin wrapper over these
 * helpers + drizzle queries; the SQL paths are verified manually
 * via click-through (per spec).
 */
import { describe, it, expect } from 'vitest'
import {
  aggregateRecoveryRows,
  recoveryRatePct,
  startOfMonthUtc,
  type RecoveryAggRow,
} from '../lib/stats'

describe('startOfMonthUtc', () => {
  it('returns 00:00:00 UTC on the 1st of the current month', () => {
    const sample = new Date('2026-04-15T13:24:00Z')
    expect(startOfMonthUtc(sample).toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('handles month boundary correctly (last second of a month → that month, not next)', () => {
    const sample = new Date('2026-03-31T23:59:59Z')
    expect(startOfMonthUtc(sample).toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('handles January correctly (no off-by-one on year)', () => {
    const sample = new Date('2026-01-05T10:00:00Z')
    expect(startOfMonthUtc(sample).toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('recoveryRatePct', () => {
  it('returns null when both numerator and denominator are 0', () => {
    expect(recoveryRatePct(0, 0)).toBe(null)
  })

  it('returns 100 when nothing has been lost', () => {
    expect(recoveryRatePct(5, 0)).toBe(100)
  })

  it('returns 0 when nothing has been recovered', () => {
    expect(recoveryRatePct(0, 5)).toBe(0)
  })

  it('rounds to nearest integer', () => {
    expect(recoveryRatePct(1, 2)).toBe(33)   // 33.33% → 33
    expect(recoveryRatePct(2, 1)).toBe(67)   // 66.67% → 67
  })

  it('handles realistic mid-range numbers', () => {
    expect(recoveryRatePct(24, 51)).toBe(32) // 32% — the worked example
    expect(recoveryRatePct(89, 11)).toBe(89) // 89% — payment-recovery rate
  })
})

describe('aggregateRecoveryRows', () => {
  it('returns all-zero buckets when given no rows', () => {
    const result = aggregateRecoveryRows([])
    expect(result).toEqual({
      winBackThisMonth: { recovered: 0, mrrRecoveredCents: 0 },
      winBackAllTime: { recovered: 0, mrrRecoveredCents: 0 },
      paymentThisMonth: { recovered: 0, mrrRecoveredCents: 0 },
      paymentAllTime: { recovered: 0, mrrRecoveredCents: 0 },
      legacyNullCount: 0,
    })
  })

  it('puts win_back rows into win-back buckets only', () => {
    const rows: RecoveryAggRow[] = [
      { recoveryType: 'win_back', isThisMonth: true, count: 3, mrrCents: 6000 },
      { recoveryType: 'win_back', isThisMonth: false, count: 21, mrrCents: 42000 },
    ]
    const result = aggregateRecoveryRows(rows)

    expect(result.winBackThisMonth).toEqual({ recovered: 3, mrrRecoveredCents: 6000 })
    expect(result.winBackAllTime).toEqual({ recovered: 24, mrrRecoveredCents: 48000 })
    expect(result.paymentThisMonth).toEqual({ recovered: 0, mrrRecoveredCents: 0 })
    expect(result.paymentAllTime).toEqual({ recovered: 0, mrrRecoveredCents: 0 })
  })

  it('puts card_save rows into payment-recovery buckets only', () => {
    const rows: RecoveryAggRow[] = [
      { recoveryType: 'card_save', isThisMonth: true, count: 8, mrrCents: 25000 },
      { recoveryType: 'card_save', isThisMonth: false, count: 81, mrrCents: 395000 },
    ]
    const result = aggregateRecoveryRows(rows)

    expect(result.paymentThisMonth).toEqual({ recovered: 8, mrrRecoveredCents: 25000 })
    expect(result.paymentAllTime).toEqual({ recovered: 89, mrrRecoveredCents: 420000 })
    expect(result.winBackThisMonth).toEqual({ recovered: 0, mrrRecoveredCents: 0 })
    expect(result.winBackAllTime).toEqual({ recovered: 0, mrrRecoveredCents: 0 })
  })

  it('sums all-time as the union of this-month and prior rows of the same type', () => {
    const rows: RecoveryAggRow[] = [
      { recoveryType: 'win_back', isThisMonth: true, count: 3, mrrCents: 6000 },
      { recoveryType: 'win_back', isThisMonth: false, count: 21, mrrCents: 42000 },
      { recoveryType: 'card_save', isThisMonth: true, count: 8, mrrCents: 25000 },
      { recoveryType: 'card_save', isThisMonth: false, count: 81, mrrCents: 395000 },
    ]
    const result = aggregateRecoveryRows(rows)

    expect(result.winBackAllTime.recovered).toBe(24)
    expect(result.winBackAllTime.mrrRecoveredCents).toBe(48000)
    expect(result.paymentAllTime.recovered).toBe(89)
    expect(result.paymentAllTime.mrrRecoveredCents).toBe(420000)
  })

  it('buckets NULL recoveryType as win-back and tracks the count for telemetry', () => {
    const rows: RecoveryAggRow[] = [
      { recoveryType: null, isThisMonth: false, count: 4, mrrCents: 10000 },
      { recoveryType: 'win_back', isThisMonth: false, count: 5, mrrCents: 12000 },
    ]
    const result = aggregateRecoveryRows(rows)

    expect(result.winBackAllTime).toEqual({ recovered: 9, mrrRecoveredCents: 22000 })
    expect(result.legacyNullCount).toBe(4)
  })

  it('buckets unknown recoveryType as win-back (defensive) and does NOT count it as legacy-null', () => {
    const rows: RecoveryAggRow[] = [
      { recoveryType: 'wat', isThisMonth: true, count: 2, mrrCents: 4000 },
    ]
    const result = aggregateRecoveryRows(rows)

    expect(result.winBackThisMonth).toEqual({ recovered: 2, mrrRecoveredCents: 4000 })
    expect(result.winBackAllTime).toEqual({ recovered: 2, mrrRecoveredCents: 4000 })
    expect(result.legacyNullCount).toBe(0)
  })

  it('handles a mix of all four buckets in a single call', () => {
    const rows: RecoveryAggRow[] = [
      { recoveryType: 'win_back', isThisMonth: true, count: 3, mrrCents: 6000 },
      { recoveryType: 'win_back', isThisMonth: false, count: 21, mrrCents: 42000 },
      { recoveryType: 'card_save', isThisMonth: true, count: 8, mrrCents: 25000 },
      { recoveryType: 'card_save', isThisMonth: false, count: 81, mrrCents: 395000 },
      { recoveryType: null, isThisMonth: false, count: 1, mrrCents: 1500 },
    ]
    const result = aggregateRecoveryRows(rows)

    expect(result.winBackThisMonth).toEqual({ recovered: 3, mrrRecoveredCents: 6000 })
    expect(result.winBackAllTime).toEqual({ recovered: 25, mrrRecoveredCents: 49500 })
    expect(result.paymentThisMonth).toEqual({ recovered: 8, mrrRecoveredCents: 25000 })
    expect(result.paymentAllTime).toEqual({ recovered: 89, mrrRecoveredCents: 420000 })
    expect(result.legacyNullCount).toBe(1)
  })
})

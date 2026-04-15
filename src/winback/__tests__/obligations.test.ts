import { describe, it, expect } from 'vitest'
import {
  monthsRemaining,
  obligationForRecovery,
  sumObligations,
  MAX_ATTRIBUTION_MONTHS,
} from '../lib/obligations'

const NOW = new Date('2026-04-15T00:00:00Z')
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000)

describe('monthsRemaining', () => {
  it('returns 0 when attribution already ended', () => {
    expect(monthsRemaining(daysFromNow(-1), NOW)).toBe(0)
  })
  it('returns 0 at exactly the end boundary', () => {
    expect(monthsRemaining(NOW, NOW)).toBe(0)
  })
  it('rounds partial months up to whole months', () => {
    expect(monthsRemaining(daysFromNow(1), NOW)).toBe(1)
    expect(monthsRemaining(daysFromNow(31), NOW)).toBe(2)
  })
  it('caps at 12 months even if attribution was somehow set further out', () => {
    expect(monthsRemaining(daysFromNow(365 * 2), NOW)).toBe(MAX_ATTRIBUTION_MONTHS)
  })
  it('returns 12 at roughly a full year out', () => {
    expect(monthsRemaining(daysFromNow(360), NOW)).toBe(12)
  })
})

describe('obligationForRecovery', () => {
  it('is zero for an inactive recovery regardless of window', () => {
    expect(
      obligationForRecovery(
        { planMrrCents: 10000, attributionEndsAt: daysFromNow(300), stillActive: false },
        NOW,
      ),
    ).toBe(0)
  })
  it('is zero when attribution has already ended', () => {
    expect(
      obligationForRecovery(
        { planMrrCents: 10000, attributionEndsAt: daysFromNow(-5), stillActive: true },
        NOW,
      ),
    ).toBe(0)
  })
  it('computes 15% × months against a mid-window active recovery', () => {
    // 60 days remaining → ceil(60/30) = 2 months. 10000 cents × 0.15 × 2 = 3000.
    expect(
      obligationForRecovery(
        { planMrrCents: 10000, attributionEndsAt: daysFromNow(60), stillActive: true },
        NOW,
      ),
    ).toBe(3000)
  })
  it('clamps the month count at 12', () => {
    // Pretend a recovery was mis-written 18 months out — we still only owe 12.
    // 10000 cents × 0.15 × 12 = 18000.
    expect(
      obligationForRecovery(
        { planMrrCents: 10000, attributionEndsAt: daysFromNow(540), stillActive: true },
        NOW,
      ),
    ).toBe(18000)
  })
  it('handles stillActive=null as inactive (defensive against NULLs)', () => {
    expect(
      obligationForRecovery(
        { planMrrCents: 10000, attributionEndsAt: daysFromNow(60), stillActive: null },
        NOW,
      ),
    ).toBe(0)
  })
})

describe('sumObligations', () => {
  it('sums across a mixed set and excludes inactive/expired', () => {
    const rows = [
      // Active, 3 months remaining on £50/mo → 15% × 3 × 5000 = 2250
      { planMrrCents: 5000, attributionEndsAt: daysFromNow(90), stillActive: true },
      // Active, already past end — 0
      { planMrrCents: 5000, attributionEndsAt: daysFromNow(-10), stillActive: true },
      // Cancelled again — 0
      { planMrrCents: 12000, attributionEndsAt: daysFromNow(180), stillActive: false },
      // Active, 6 months remaining on £120/mo → 15% × 6 × 12000 = 10800
      { planMrrCents: 12000, attributionEndsAt: daysFromNow(180), stillActive: true },
    ]
    expect(sumObligations(rows, NOW)).toBe(2250 + 10800)
  })
  it('returns 0 for an empty list', () => {
    expect(sumObligations([], NOW)).toBe(0)
  })
})

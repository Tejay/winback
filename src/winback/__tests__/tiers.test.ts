import { describe, it, expect } from 'vitest'
import {
  tierFromMrr,
  tierFromMrrWithHysteresis,
  tierRank,
  tierLabel,
  tierBandLabel,
} from '../lib/tiers'

/**
 * Tier resolution — boundaries, bias-low at first activation, hysteresis
 * on downgrades. These guard the dispute-proof property: we never
 * silently overcharge.
 */

describe('tierFromMrr (no bias)', () => {
  it('returns starter at $0', () => {
    expect(tierFromMrr(0)).toBe('starter')
  })

  it('returns starter just below the Growth boundary', () => {
    expect(tierFromMrr(49_999_99)).toBe('starter')
  })

  it('returns growth exactly at $50,000', () => {
    expect(tierFromMrr(50_000_00)).toBe('growth')
  })

  it('returns growth just below the Scale boundary', () => {
    expect(tierFromMrr(249_999_99)).toBe('growth')
  })

  it('returns scale exactly at $250,000', () => {
    expect(tierFromMrr(250_000_00)).toBe('scale')
  })

  it('returns scale just below the Enterprise boundary', () => {
    expect(tierFromMrr(999_999_99)).toBe('scale')
  })

  it('returns enterprise at $1,000,000', () => {
    expect(tierFromMrr(1_000_000_00)).toBe('enterprise')
  })

  it('returns enterprise at $10M', () => {
    expect(tierFromMrr(10_000_000_00)).toBe('enterprise')
  })
})

describe('tierFromMrr (biasLow at first activation)', () => {
  it('stays in starter at exactly the bias-low edge ($52,499 ≤ $50,000×1.05)', () => {
    // $50,000 × (1 + 0.05) = $52,500. So $52,499 is in the bias zone.
    expect(tierFromMrr(52_499_99, { biasLow: true })).toBe('starter')
  })

  it('flips to growth just past the bias edge ($52,500)', () => {
    expect(tierFromMrr(52_500_01, { biasLow: true })).toBe('growth')
  })

  it('stays in growth at the Scale bias-low edge ($262,500)', () => {
    // $250,000 × 1.05 = $262,500
    expect(tierFromMrr(262_499_99, { biasLow: true })).toBe('growth')
  })

  it('flips to scale past the Scale bias-low edge', () => {
    expect(tierFromMrr(262_500_01, { biasLow: true })).toBe('scale')
  })

  it('stays in scale near the Enterprise bias-low edge ($1.05M)', () => {
    expect(tierFromMrr(1_049_999_99, { biasLow: true })).toBe('scale')
  })

  it('flips to enterprise past the Enterprise bias-low edge', () => {
    expect(tierFromMrr(1_050_000_01, { biasLow: true })).toBe('enterprise')
  })

  it('biasLow has no effect at $0 (no lower band exists)', () => {
    expect(tierFromMrr(0, { biasLow: true })).toBe('starter')
  })
})

describe('tierFromMrrWithHysteresis (mid-life downgrade anti-seesaw)', () => {
  it('returns natural tier when there is no current billed tier', () => {
    expect(tierFromMrrWithHysteresis(40_000_00, null)).toBe('starter')
    expect(tierFromMrrWithHysteresis(60_000_00, null)).toBe('growth')
  })

  it('keeps Growth customer on Growth at $49,500 (above $45k hysteresis floor)', () => {
    // $50,000 × (1 - 0.10) = $45,000 floor. $49,500 is above it.
    expect(tierFromMrrWithHysteresis(49_500_00, 'growth')).toBe('growth')
  })

  it('keeps Growth customer on Growth at exactly $45,000 (boundary inclusive)', () => {
    // The check is `mrr < floor`, so $45,000 stays.
    expect(tierFromMrrWithHysteresis(45_000_00, 'growth')).toBe('growth')
  })

  it('downgrades Growth customer to Starter at $44,999 (past hysteresis floor)', () => {
    expect(tierFromMrrWithHysteresis(44_999_99, 'growth')).toBe('starter')
  })

  it('keeps Scale customer on Scale at $225,000', () => {
    // $250k × (1 - 0.10) = $225k floor
    expect(tierFromMrrWithHysteresis(225_000_00, 'scale')).toBe('scale')
  })

  it('downgrades Scale customer to Growth at $224,999', () => {
    expect(tierFromMrrWithHysteresis(224_999_99, 'scale')).toBe('growth')
  })

  it('allows upgrade without hysteresis (Starter → Growth at $50,000)', () => {
    // Hysteresis is downgrade-only. Upgrades use the strict boundary.
    expect(tierFromMrrWithHysteresis(50_000_00, 'starter')).toBe('growth')
  })

  it('allows upgrade Starter → Scale on a big jump', () => {
    expect(tierFromMrrWithHysteresis(500_000_00, 'starter')).toBe('scale')
  })

  it('helper drops enterprise → scale on a deep MRR drop; the "stay enterprise" semantics belong to the prompt layer, not this helper', () => {
    // This helper just computes the natural recommendation (with
    // hysteresis on downgrades). The "no auto-downgrade from
    // enterprise to a self-serve tier" rule lives in tier-transitions
    // (it suppresses prompts for enterprise customers regardless of
    // the recommendation). The pure helper is allowed to recommend
    // scale here — the suppression layer keeps the customer billing
    // unchanged.
    expect(tierFromMrrWithHysteresis(800_000_00, 'enterprise')).toBe('scale')
  })

  it('downgrades Growth → Starter only on a deep drop', () => {
    expect(tierFromMrrWithHysteresis(10_000_00, 'growth')).toBe('starter')
  })
})

describe('tierRank', () => {
  it('orders tiers ascending by cost', () => {
    expect(tierRank('starter')).toBe(0)
    expect(tierRank('growth')).toBe(1)
    expect(tierRank('scale')).toBe(2)
    expect(tierRank('enterprise')).toBe(3)
  })
})

describe('tierLabel', () => {
  it('returns human labels for each tier', () => {
    expect(tierLabel('starter')).toBe('Starter')
    expect(tierLabel('growth')).toBe('Growth')
    expect(tierLabel('scale')).toBe('Scale')
    expect(tierLabel('enterprise')).toBe('Enterprise')
  })
})

describe('tierBandLabel', () => {
  it('renders Starter as a closed range ending at the Growth floor', () => {
    expect(tierBandLabel('starter')).toBe('$0 – $50k')
  })

  it('renders Growth as $50k – $250k', () => {
    expect(tierBandLabel('growth')).toBe('$50k – $250k')
  })

  it('renders Scale as $250k – $1M', () => {
    expect(tierBandLabel('scale')).toBe('$250k – $1M')
  })

  it('renders Enterprise as $1M+', () => {
    expect(tierBandLabel('enterprise')).toBe('$1M+')
  })
})

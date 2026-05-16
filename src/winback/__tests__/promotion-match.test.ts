import { describe, it, expect } from 'vitest'
import {
  getApplicablePromotionForSubscriber,
  parsePromotionRows,
  type PromotionRow,
  type PromotionSubscriberSignals,
} from '../lib/promotion-match'
import {
  describePromotionRestrictions,
  type WbPromotionMetadata,
} from '../lib/promotions'

/**
 * Spec 78 followup — single-selected-promotion gate tests.
 *
 * No tiebreak, no value math, no LLM. The merchant picks one promo on
 * /reasons; this function says yes/no for each subscriber against the
 * four bulletproof gates.
 */

function meta(overrides: Partial<WbPromotionMetadata> = {}): WbPromotionMetadata {
  return {
    stripeCouponId:        'cpn_test',
    stripePromotionCodeId: 'promo_test',
    code:                  'TEST25',
    name:                  null,
    percentOff:            25,
    amountOffCents:        null,
    currency:              null,
    duration:              'repeating',
    durationInMonths:      3,
    redeemBy:              null,
    appliesToPriceIds:     [],
    maxRedemptions:        null,
    timesRedeemed:         0,
    active:                true,
    syncedAt:              new Date().toISOString(),
    restrictions:          null,
    firstTimeTransaction:  null,
    ...overrides,
  }
}

function row(id: string, m: Partial<WbPromotionMetadata>, createdAt = new Date()): PromotionRow {
  return { id, promotionMetadata: meta(m), createdAt }
}

const baseSub: PromotionSubscriberSignals = {
  tier: 1,
  cancellationCategory: 'Price',
  mrrCents: 10000,
  stripePriceId: 'price_pro',
}

describe('getApplicablePromotionForSubscriber — short-circuits', () => {
  it('returns null when promotionsEnabled = false', () => {
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', {}), false)).toBeNull()
  })

  it('returns null when no promo selected', () => {
    expect(getApplicablePromotionForSubscriber(baseSub, null, true)).toBeNull()
  })

  it('returns null when tier ≠ 1', () => {
    expect(getApplicablePromotionForSubscriber({ ...baseSub, tier: 2 }, row('a', {}), true)).toBeNull()
    expect(getApplicablePromotionForSubscriber({ ...baseSub, tier: null }, row('a', {}), true)).toBeNull()
  })

  it('returns null when cancellationCategory ≠ Price', () => {
    expect(getApplicablePromotionForSubscriber({ ...baseSub, cancellationCategory: 'Feature' }, row('a', {}), true)).toBeNull()
    expect(getApplicablePromotionForSubscriber({ ...baseSub, cancellationCategory: 'Other' }, row('a', {}), true)).toBeNull()
  })
})

describe('getApplicablePromotionForSubscriber — gates', () => {
  it('returns null when promo is inactive', () => {
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', { active: false }), true)).toBeNull()
  })

  it('returns null when promo redeemBy has passed', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', { redeemBy: yesterday }), true)).toBeNull()
  })

  it('matches when promo redeemBy is in the future', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', { redeemBy: tomorrow }), true)?.id).toBe('a')
  })

  it('returns null when promo is max-redeemed', () => {
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', { maxRedemptions: 5, timesRedeemed: 5 }), true)).toBeNull()
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', { maxRedemptions: 5, timesRedeemed: 10 }), true)).toBeNull()
  })

  it('matches when promo has redemptions left', () => {
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', { maxRedemptions: 5, timesRedeemed: 3 }), true)?.id).toBe('a')
  })

  it('returns null when promo appliesToPriceIds excludes subscriber price', () => {
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', { appliesToPriceIds: ['price_starter'] }), true)).toBeNull()
  })

  it('matches when promo appliesToPriceIds is empty (= all plans)', () => {
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', { appliesToPriceIds: [] }), true)?.id).toBe('a')
  })

  it('matches when promo appliesToPriceIds includes subscriber price', () => {
    expect(getApplicablePromotionForSubscriber(baseSub, row('a', { appliesToPriceIds: ['price_starter', 'price_pro'] }), true)?.id).toBe('a')
  })

  it('returns null when subscriber has no stripePriceId and promo is plan-restricted', () => {
    const promo = row('a', { appliesToPriceIds: ['price_pro'] })
    expect(getApplicablePromotionForSubscriber({ ...baseSub, stripePriceId: null }, promo, true)).toBeNull()
  })
})

describe('describePromotionRestrictions', () => {
  it('reports all-plans when appliesToPriceIds is empty', () => {
    const got = describePromotionRestrictions(meta())
    expect(got.winbackChecks).toContain('all plans')
    expect(got.merchantVerifies).toEqual([])
  })

  it('reports plan count when restricted', () => {
    const got = describePromotionRestrictions(meta({ appliesToPriceIds: ['price_a', 'price_b'] }))
    expect(got.winbackChecks).toContain('2 plans')
  })

  it('flags first-time transaction as merchant-verified', () => {
    const got = describePromotionRestrictions(meta({ firstTimeTransaction: true }))
    expect(got.merchantVerifies).toContain('first-time customers only')
  })

  it('flags minimum_amount as merchant-verified', () => {
    const got = describePromotionRestrictions(meta({
      restrictions: { minimum_amount: 5000, minimum_amount_currency: 'usd' },
    }))
    expect(got.merchantVerifies.some((s) => s.startsWith('min 50.00 USD'))).toBe(true)
  })

  it('flags amount-off coupons as currency-locked', () => {
    const got = describePromotionRestrictions(meta({
      percentOff: null,
      amountOffCents: 1000,
      currency: 'eur',
    }))
    expect(got.merchantVerifies).toContain('EUR subscriptions only')
  })

  it('flags unknown restriction keys', () => {
    const got = describePromotionRestrictions(meta({
      restrictions: { some_future_stripe_field: 'foo' },
    }))
    expect(got.merchantVerifies.some((s) => s.includes('some_future_stripe_field'))).toBe(true)
  })
})

describe('parsePromotionRows', () => {
  it('drops rows whose metadata fails validation', () => {
    const out = parsePromotionRows([
      { id: 'good', promotionMetadata: meta(), createdAt: new Date() },
      { id: 'bad',  promotionMetadata: { not: 'a promo' }, createdAt: new Date() },
      { id: 'null', promotionMetadata: null, createdAt: new Date() },
    ])
    expect(out.map((r) => r.id)).toEqual(['good'])
  })
})

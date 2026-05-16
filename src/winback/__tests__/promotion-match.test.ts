import { describe, it, expect } from 'vitest'
import {
  findBestPromotionForSubscriber,
  parsePromotionRows,
  type PromotionRow,
  type PromotionSubscriberSignals,
} from '../lib/promotion-match'
import type { WbPromotionMetadata } from '../lib/promotions'

/**
 * Spec 78 — deterministic promotion-selection tests.
 *
 * No LLM, no DB — the matcher is pure code on top of validated metadata.
 * Each test sets up a small fixture and asserts on which promo (if any)
 * comes back as the winner.
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

describe('findBestPromotionForSubscriber — eligibility gate', () => {
  it('returns null when promotionsEnabled = false', () => {
    expect(findBestPromotionForSubscriber(baseSub, [row('a', {})], false)).toBeNull()
  })

  it('returns null when tier ≠ 1', () => {
    expect(findBestPromotionForSubscriber({ ...baseSub, tier: 2 }, [row('a', {})], true)).toBeNull()
    expect(findBestPromotionForSubscriber({ ...baseSub, tier: null }, [row('a', {})], true)).toBeNull()
  })

  it('returns null when cancellationCategory ≠ Price', () => {
    expect(findBestPromotionForSubscriber({ ...baseSub, cancellationCategory: 'Feature' }, [row('a', {})], true)).toBeNull()
    expect(findBestPromotionForSubscriber({ ...baseSub, cancellationCategory: 'Other' }, [row('a', {})], true)).toBeNull()
  })

  it('returns null when promo is inactive', () => {
    expect(findBestPromotionForSubscriber(baseSub, [row('a', { active: false })], true)).toBeNull()
  })

  it('returns null when promo redeemBy has passed', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    expect(findBestPromotionForSubscriber(baseSub, [row('a', { redeemBy: yesterday })], true)).toBeNull()
  })

  it('matches when promo redeemBy is in the future', () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    const got = findBestPromotionForSubscriber(baseSub, [row('a', { redeemBy: tomorrow })], true)
    expect(got?.id).toBe('a')
  })

  it('returns null when promo is max-redeemed', () => {
    expect(findBestPromotionForSubscriber(baseSub, [row('a', { maxRedemptions: 5, timesRedeemed: 5 })], true)).toBeNull()
    expect(findBestPromotionForSubscriber(baseSub, [row('a', { maxRedemptions: 5, timesRedeemed: 10 })], true)).toBeNull()
  })

  it('matches when promo has redemptions left', () => {
    const got = findBestPromotionForSubscriber(baseSub, [row('a', { maxRedemptions: 5, timesRedeemed: 3 })], true)
    expect(got?.id).toBe('a')
  })

  it('returns null when promo appliesToPriceIds excludes subscriber price', () => {
    const promo = row('a', { appliesToPriceIds: ['price_starter'] })
    expect(findBestPromotionForSubscriber(baseSub, [promo], true)).toBeNull()
  })

  it('matches when promo appliesToPriceIds is empty (= all plans)', () => {
    const promo = row('a', { appliesToPriceIds: [] })
    expect(findBestPromotionForSubscriber(baseSub, [promo], true)?.id).toBe('a')
  })

  it('matches when promo appliesToPriceIds includes subscriber price', () => {
    const promo = row('a', { appliesToPriceIds: ['price_starter', 'price_pro'] })
    expect(findBestPromotionForSubscriber(baseSub, [promo], true)?.id).toBe('a')
  })

  it('returns null when subscriber has no stripePriceId and promo is plan-restricted', () => {
    const promo = row('a', { appliesToPriceIds: ['price_pro'] })
    expect(findBestPromotionForSubscriber({ ...baseSub, stripePriceId: null }, [promo], true)).toBeNull()
  })

  it('returns null on empty list', () => {
    expect(findBestPromotionForSubscriber(baseSub, [], true)).toBeNull()
  })
})

describe('findBestPromotionForSubscriber — tiebreak', () => {
  it('picks the larger percent-off discount on $100 MRR', () => {
    const small = row('small', { code: 'TEN',  percentOff: 10 })
    const big   = row('big',   { code: 'FIFTY', percentOff: 50 })
    expect(findBestPromotionForSubscriber(baseSub, [small, big], true)?.id).toBe('big')
  })

  it('picks fixed amount_off > percent_off when absolute value is larger', () => {
    // 50% of $100 = $50  vs.  $75 fixed off
    const percent = row('pct',    { code: 'P50', percentOff: 50, amountOffCents: null })
    const fixed   = row('fixed',  { code: 'F75', percentOff: null, amountOffCents: 7500, currency: 'usd' })
    expect(findBestPromotionForSubscriber(baseSub, [percent, fixed], true)?.id).toBe('fixed')
  })

  it('on equal value, picks the soonest redeemBy', () => {
    const later   = row('later',   { code: 'L', percentOff: 25, redeemBy: new Date(Date.now() + 30 * 86400_000).toISOString() })
    const sooner  = row('sooner',  { code: 'S', percentOff: 25, redeemBy: new Date(Date.now() +  5 * 86400_000).toISOString() })
    expect(findBestPromotionForSubscriber(baseSub, [later, sooner], true)?.id).toBe('sooner')
  })

  it('on equal value and no redeemBy, picks the newest createdAt', () => {
    const old = row('old', { code: 'O', percentOff: 25 }, new Date('2026-01-01'))
    const fresh = row('fresh', { code: 'F', percentOff: 25 }, new Date('2026-05-01'))
    expect(findBestPromotionForSubscriber(baseSub, [old, fresh], true)?.id).toBe('fresh')
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

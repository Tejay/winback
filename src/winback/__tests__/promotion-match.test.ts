import { describe, it, expect } from 'vitest'
import {
  getApplicablePromotionForSubscriber,
  type PromotionRow,
  type PromotionSubscriberSignals,
} from '../lib/promotion-match'
import type { WbPromotionMetadata } from '../lib/promotions'

/**
 * Spec 79 — unit coverage for the four Stripe gates and the two hardcoded
 * subscriber-side filters (tier=1, cancellationCategory='Price') in
 * getApplicablePromotionForSubscriber. The matcher is the load-bearing
 * piece of the promo path; everything downstream of a wrong gate
 * (Stripe checkout rejection, dashboard chip showing the wrong promo)
 * is hard to recover from.
 *
 * Fixtures intentionally keep all 4 Stripe gates satisfied unless the
 * test is exercising a specific gate. Same for the subscriber-side
 * filters. Test names trace the line in promotion-match.ts that's
 * being exercised.
 */

const NOW = new Date('2026-06-01T12:00:00Z')

function buildPromo(overrides: Partial<WbPromotionMetadata> = {}): PromotionRow {
  const metadata: WbPromotionMetadata = {
    stripeCouponId:        'coupon_test',
    stripePromotionCodeId: 'promo_test',
    code:                  'WELCOME50',
    name:                  null,
    percentOff:            50,
    amountOffCents:        null,
    currency:              null,
    duration:              'once',
    durationInMonths:      null,
    redeemBy:              null,
    appliesToPriceIds:     [],
    maxRedemptions:        null,
    timesRedeemed:         0,
    active:                true,
    syncedAt:              NOW.toISOString(),
    restrictions:          null,
    firstTimeTransaction:  null,
    ...overrides,
  }
  return {
    id:                'imp_test',
    promotionMetadata: metadata,
    createdAt:         NOW,
  }
}

function buildSubscriber(
  overrides: Partial<PromotionSubscriberSignals> = {},
): PromotionSubscriberSignals {
  return {
    tier:                 1,
    cancellationCategory: 'Price',
    mrrCents:             10_000,
    stripePriceId:        'price_growth_monthly',
    ...overrides,
  }
}

describe('getApplicablePromotionForSubscriber — happy path', () => {
  it('returns the promo when all gates pass + tier=1 + Price category', () => {
    const promo = buildPromo()
    const sub = buildSubscriber()
    expect(getApplicablePromotionForSubscriber(sub, promo, true, NOW)).toBe(promo)
  })
})

describe('subscriber-side filters', () => {
  it('returns null when promotionsEnabled is false', () => {
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber(), buildPromo(), false, NOW),
    ).toBeNull()
  })

  it('returns null when no promo is selected (null)', () => {
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber(), null, true, NOW),
    ).toBeNull()
  })

  it('returns null when subscriber.tier is not 1', () => {
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber({ tier: 2 }), buildPromo(), true, NOW),
    ).toBeNull()
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber({ tier: 3 }), buildPromo(), true, NOW),
    ).toBeNull()
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber({ tier: null }), buildPromo(), true, NOW),
    ).toBeNull()
  })

  it('returns null when cancellationCategory is not "Price"', () => {
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber({ cancellationCategory: 'Feature' }), buildPromo(), true, NOW,
      ),
    ).toBeNull()
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber({ cancellationCategory: 'Bug' }), buildPromo(), true, NOW,
      ),
    ).toBeNull()
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber({ cancellationCategory: null }), buildPromo(), true, NOW,
      ),
    ).toBeNull()
  })
})

describe('Stripe gate 1 — active', () => {
  it('returns null when promo.active is false', () => {
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber(), buildPromo({ active: false }), true, NOW,
      ),
    ).toBeNull()
  })
})

describe('Stripe gate 2 — redeemBy', () => {
  it('returns null when redeemBy is in the past', () => {
    const yesterday = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber(),
        buildPromo({ redeemBy: yesterday.toISOString() }),
        true,
        NOW,
      ),
    ).toBeNull()
  })

  it('returns null when redeemBy is exactly now (inclusive boundary)', () => {
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber(),
        buildPromo({ redeemBy: NOW.toISOString() }),
        true,
        NOW,
      ),
    ).toBeNull()
  })

  it('returns the promo when redeemBy is in the future', () => {
    const tomorrow = new Date(NOW.getTime() + 24 * 60 * 60 * 1000)
    const promo = buildPromo({ redeemBy: tomorrow.toISOString() })
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber(), promo, true, NOW),
    ).toBe(promo)
  })

  it('returns the promo when redeemBy is null (no deadline)', () => {
    const promo = buildPromo({ redeemBy: null })
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber(), promo, true, NOW),
    ).toBe(promo)
  })

  it('returns the promo when redeemBy is an invalid date string (defensive)', () => {
    // Implementation uses Number.isNaN(expiresAt.getTime()) to skip the
    // check on unparseable strings — fail-open rather than fail-closed.
    const promo = buildPromo({ redeemBy: 'not-a-date' })
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber(), promo, true, NOW),
    ).toBe(promo)
  })
})

describe('Stripe gate 3 — maxRedemptions cap', () => {
  it('returns null when timesRedeemed equals maxRedemptions', () => {
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber(),
        buildPromo({ maxRedemptions: 5, timesRedeemed: 5 }),
        true,
        NOW,
      ),
    ).toBeNull()
  })

  it('returns null when timesRedeemed exceeds maxRedemptions', () => {
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber(),
        buildPromo({ maxRedemptions: 5, timesRedeemed: 6 }),
        true,
        NOW,
      ),
    ).toBeNull()
  })

  it('returns the promo when timesRedeemed is below maxRedemptions', () => {
    const promo = buildPromo({ maxRedemptions: 10, timesRedeemed: 3 })
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber(), promo, true, NOW),
    ).toBe(promo)
  })

  it('returns the promo when maxRedemptions is null (unlimited)', () => {
    const promo = buildPromo({ maxRedemptions: null, timesRedeemed: 1_000 })
    expect(
      getApplicablePromotionForSubscriber(buildSubscriber(), promo, true, NOW),
    ).toBe(promo)
  })
})

describe('Stripe gate 4 — appliesToPriceIds', () => {
  it('returns null when subscriber price is not in the applies-to list', () => {
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber({ stripePriceId: 'price_starter' }),
        buildPromo({ appliesToPriceIds: ['price_growth', 'price_scale'] }),
        true,
        NOW,
      ),
    ).toBeNull()
  })

  it('returns null when subscriber has no stripePriceId and promo is plan-restricted', () => {
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber({ stripePriceId: null }),
        buildPromo({ appliesToPriceIds: ['price_growth'] }),
        true,
        NOW,
      ),
    ).toBeNull()
  })

  it('returns the promo when subscriber price is in the applies-to list', () => {
    const promo = buildPromo({ appliesToPriceIds: ['price_growth', 'price_scale'] })
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber({ stripePriceId: 'price_growth' }),
        promo,
        true,
        NOW,
      ),
    ).toBe(promo)
  })

  it('returns the promo when applies-to list is empty (all plans)', () => {
    const promo = buildPromo({ appliesToPriceIds: [] })
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber({ stripePriceId: null }),
        promo,
        true,
        NOW,
      ),
    ).toBe(promo)
  })
})

describe('compound failure', () => {
  it('returns null when multiple gates fail (no short-circuit ordering reliance)', () => {
    expect(
      getApplicablePromotionForSubscriber(
        buildSubscriber({ tier: 2 }),
        buildPromo({ active: false, maxRedemptions: 1, timesRedeemed: 1 }),
        false,
        NOW,
      ),
    ).toBeNull()
  })
})

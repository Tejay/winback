/**
 * MRR computation from a connected Stripe account.
 *
 * Pure function: takes an OAuth access token, returns an MRR figure in USD.
 * No DB writes here — caller (mrr-snapshot.ts) persists the result.
 *
 * Rules (mirrored from the spec — adjust only with paired test changes):
 *
 *  - Include subscriptions in status: 'active' | 'past_due'.
 *  - Exclude 'trialing', 'canceled', 'incomplete', 'incomplete_expired',
 *    'unpaid', 'paused' — but COUNT them so the breakdown UI can show
 *    "5 trialing (excluded)" for transparency.
 *  - Per item, normalize the recurring amount to monthly:
 *      month → unit_amount
 *      year  → unit_amount / 12
 *      week  → unit_amount * 52 / 12
 *      day   → unit_amount * 365 / 12
 *    Multiply by recurring.interval_count and item.quantity.
 *  - billing_scheme 'tiered' → walk the tiers ladder up to the item
 *    quantity, sum amount_per_tier.
 *  - recurring.usage_type 'metered' → exclude.
 *  - Apply active discounts/coupons (subscription-level and item-level).
 *  - Convert each item's monthly amount (in its native currency) to USD
 *    via the FX cache. Skip items whose currency has no rate at all and
 *    log a warning.
 */

import type Stripe from 'stripe'
import { getConnectStripe } from './stripe'
import { convertToUsdMinor } from './fx'

export type MrrPerCurrency = Record<string, number>

export type MrrBreakdown = {
  activeSubscriptionCount: number
  pastDueSubscriptionCount: number
  excludedTrialingCount: number
  excludedCanceledCount: number
  excludedOtherCount: number
  /** Subscriptions whose currency had no FX rate — contribution skipped. */
  skippedMissingFxCount: number
  /** Items skipped because they were purely metered with no committed base. */
  skippedMeteredCount: number
}

export type MrrResult = {
  totalUsdMinor: number
  perCurrency: MrrPerCurrency
  breakdown: MrrBreakdown
}

const INCLUDED_STATUSES: ReadonlyArray<Stripe.Subscription.Status> = [
  'active',
  'past_due',
]

export async function computeMrrFromStripe(
  accessToken: string,
): Promise<MrrResult> {
  const stripe = getConnectStripe(accessToken)
  return computeMrrViaClient(stripe)
}

/**
 * Variant for tests / second-opinion paths that already have a Stripe
 * client constructed (e.g., for Connect with Stripe-Account header).
 */
export async function computeMrrViaClient(
  stripe: Stripe,
): Promise<MrrResult> {
  const breakdown: MrrBreakdown = {
    activeSubscriptionCount: 0,
    pastDueSubscriptionCount: 0,
    excludedTrialingCount: 0,
    excludedCanceledCount: 0,
    excludedOtherCount: 0,
    skippedMissingFxCount: 0,
    skippedMeteredCount: 0,
  }
  const perCurrency: MrrPerCurrency = {}
  let totalUsdMinor = 0

  // Page through ALL subscriptions (any status) — we count excluded
  // statuses for the breakdown, then sum only the included ones.
  for await (const sub of stripe.subscriptions.list({
    status: 'all',
    limit: 100,
    expand: ['data.discounts', 'data.items.data.discounts'],
  })) {
    switch (sub.status) {
      case 'active':
        breakdown.activeSubscriptionCount += 1
        break
      case 'past_due':
        breakdown.pastDueSubscriptionCount += 1
        break
      case 'trialing':
        breakdown.excludedTrialingCount += 1
        continue
      case 'canceled':
        breakdown.excludedCanceledCount += 1
        continue
      default:
        breakdown.excludedOtherCount += 1
        continue
    }
    if (!INCLUDED_STATUSES.includes(sub.status)) continue

    // Compute native-currency monthly contribution per item, then convert.
    // We do conversion at item level so a multi-currency subscription
    // (rare but legal) lands correctly in perCurrency.
    let subUsdMinor = 0
    let subContributedToTotal = false

    for (const item of sub.items.data) {
      const price = item.price
      if (!price) continue

      // Metered items have no committed recurring base — exclude.
      if (price.recurring?.usage_type === 'metered') {
        breakdown.skippedMeteredCount += 1
        continue
      }

      const itemMonthlyNative = itemMonthlyAmountNativeMinor(item)
      if (itemMonthlyNative === 0) continue

      const currency = (price.currency || 'usd').toLowerCase()

      // Apply item-level discounts first, then subscription-level.
      const afterItemDiscount = applyDiscountsToAmount(
        itemMonthlyNative,
        getItemDiscounts(item),
      )
      const afterAllDiscount = applyDiscountsToAmount(
        afterItemDiscount,
        getSubscriptionDiscounts(sub),
      )
      if (afterAllDiscount <= 0) continue

      perCurrency[currency] = (perCurrency[currency] ?? 0) + afterAllDiscount

      const usdMinor = await convertToUsdMinor(afterAllDiscount, currency)
      if (usdMinor === null) {
        breakdown.skippedMissingFxCount += 1
        continue
      }
      subUsdMinor += usdMinor
      subContributedToTotal = true
    }

    if (subContributedToTotal) {
      totalUsdMinor += subUsdMinor
    }
  }

  return { totalUsdMinor, perCurrency, breakdown }
}

/**
 * Returns the monthly-normalized native-minor amount for one subscription
 * item, BEFORE discounts. Handles per_unit and tiered Prices, all four
 * recurring intervals, interval_count, and item quantity.
 *
 * Returns 0 for items that should not contribute (no recurring config,
 * metered without flat base — though metered is filtered earlier — etc.).
 */
function itemMonthlyAmountNativeMinor(item: Stripe.SubscriptionItem): number {
  const price = item.price
  if (!price) return 0
  if (!price.recurring) return 0

  const interval = price.recurring.interval
  const intervalCount = price.recurring.interval_count ?? 1
  const quantity = item.quantity ?? 1

  // Single-unit price for this billing period (across all units the
  // customer is paying for), BEFORE we normalize to monthly.
  let perPeriodAmount = 0

  if (price.billing_scheme === 'per_unit') {
    const unit = unitAmountOfPrice(price)
    perPeriodAmount = unit * quantity
  } else if (price.billing_scheme === 'tiered') {
    perPeriodAmount = tieredAmountForQuantity(price, quantity)
  } else {
    // Unknown shape — be conservative, contribute nothing.
    return 0
  }

  if (perPeriodAmount <= 0) return 0

  // Normalize the per-period amount to monthly.
  const periodDurationMonths = intervalToMonths(interval) * intervalCount
  if (periodDurationMonths === 0) return 0
  return Math.round(perPeriodAmount / periodDurationMonths)
}

function unitAmountOfPrice(price: Stripe.Price): number {
  // unit_amount_decimal beats unit_amount when present — sub-cent precision.
  if (price.unit_amount_decimal != null) {
    return Math.round(Number(price.unit_amount_decimal))
  }
  return price.unit_amount ?? 0
}

function intervalToMonths(interval: Stripe.Price.Recurring.Interval): number {
  switch (interval) {
    case 'month': return 1
    case 'year':  return 12
    case 'week':  return 12 / 52   // ≈ 0.2308
    case 'day':   return 12 / 365  // ≈ 0.0329
    default:      return 0
  }
}

/**
 * For tiered Prices: walk the tiers ladder, summing up_to brackets * their
 * unit amounts, until we've accounted for `quantity` units. Supports both
 * `graduated` (each tier priced separately) and `volume` (all units at the
 * tier that contains the quantity) tiers_mode.
 */
function tieredAmountForQuantity(
  price: Stripe.Price,
  quantity: number,
): number {
  const tiers = price.tiers ?? []
  if (tiers.length === 0) return 0
  const mode = price.tiers_mode ?? 'graduated'

  if (mode === 'volume') {
    // Find the single tier that contains `quantity`, then apply its
    // unit_amount × quantity + flat_amount.
    for (const tier of tiers) {
      const upTo = tierUpTo(tier)
      if (quantity <= upTo) {
        return (
          (tierUnitAmount(tier) * quantity) + (tier.flat_amount ?? 0)
        )
      }
    }
    // Past all tiers — apply the last (catch-all) tier.
    const last = tiers[tiers.length - 1]
    return (tierUnitAmount(last) * quantity) + (last.flat_amount ?? 0)
  }

  // 'graduated' — walk each tier and bill its slice.
  let total = 0
  let remaining = quantity
  let priorUpTo = 0
  for (const tier of tiers) {
    if (remaining <= 0) break
    const upTo = tierUpTo(tier)
    const slice = Math.min(remaining, upTo - priorUpTo)
    if (slice > 0) {
      total += tierUnitAmount(tier) * slice
      total += tier.flat_amount ?? 0
      remaining -= slice
      priorUpTo = upTo
    } else if (upTo === Infinity) {
      // Last bracket catches anything left.
      total += tierUnitAmount(tier) * remaining
      total += tier.flat_amount ?? 0
      remaining = 0
    }
  }
  return total
}

function tierUpTo(tier: Stripe.Price.Tier): number {
  if (tier.up_to === null || tier.up_to === undefined) return Infinity
  return typeof tier.up_to === 'number' ? tier.up_to : Infinity
}

function tierUnitAmount(tier: Stripe.Price.Tier): number {
  if (tier.unit_amount_decimal != null) {
    return Math.round(Number(tier.unit_amount_decimal))
  }
  return tier.unit_amount ?? 0
}

type DiscountLike = {
  coupon?: {
    amount_off?: number | null
    percent_off?: number | null
  } | null
}

function getSubscriptionDiscounts(sub: Stripe.Subscription): DiscountLike[] {
  // `discounts` may be an array of ids or expanded objects per the
  // Stripe SDK. We expanded above, so prefer the array; fall back to
  // legacy single `discount` if present.
  const arr = (sub as unknown as { discounts?: unknown[] }).discounts
  if (Array.isArray(arr)) return arr.filter(isDiscountObject)
  const legacy = (sub as unknown as { discount?: unknown }).discount
  if (legacy && isDiscountObject(legacy)) return [legacy]
  return []
}

function getItemDiscounts(item: Stripe.SubscriptionItem): DiscountLike[] {
  const arr = (item as unknown as { discounts?: unknown[] }).discounts
  if (Array.isArray(arr)) return arr.filter(isDiscountObject)
  return []
}

function isDiscountObject(x: unknown): x is DiscountLike {
  return typeof x === 'object' && x !== null && 'coupon' in x
}

function applyDiscountsToAmount(
  baseAmount: number,
  discounts: DiscountLike[],
): number {
  let amount = baseAmount
  for (const d of discounts) {
    const coupon = d.coupon
    if (!coupon) continue
    if (typeof coupon.percent_off === 'number' && coupon.percent_off > 0) {
      amount = Math.round(amount * (1 - coupon.percent_off / 100))
    }
    if (typeof coupon.amount_off === 'number' && coupon.amount_off > 0) {
      amount = Math.max(0, amount - coupon.amount_off)
    }
  }
  return amount
}

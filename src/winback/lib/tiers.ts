/**
 * Tier resolution helpers — pure functions on top of billing-config.
 *
 * All business logic that needs to map MRR → tier or tier → price/lookup-key
 * goes through here. No magic numbers, no inlined boundaries — call these.
 */

import type Stripe from 'stripe'
import {
  TIERS,
  BAND_EDGE_BIAS_PCT,
  DOWNGRADE_HYSTERESIS_PCT,
  tierConfig,
  type TierKey,
  type TierConfig,
} from './billing-config'

/**
 * Returns the tier whose MRR band contains `mrrUsdMinor`.
 *
 * `biasLow` (used ONLY at first activation): if `mrrUsdMinor` is within
 * BAND_EDGE_BIAS_PCT of the upper boundary of the lower band, return the
 * lower band. Errors round in the customer's favor.
 *
 * Mid-life transitions DO NOT use biasLow — they use the strict band for
 * upgrades and a separate hysteresis function for downgrades.
 */
export function tierFromMrr(
  mrrUsdMinor: number,
  opts: { biasLow?: boolean } = {},
): TierKey {
  const biasLow = opts.biasLow === true

  // Find the natural band first.
  const natural = TIERS.find(
    (t) =>
      mrrUsdMinor >= t.minUsdMinor &&
      (t.maxUsdMinor === null || mrrUsdMinor <= t.maxUsdMinor),
  )
  if (!natural) {
    // Should be unreachable — TIERS covers 0..∞.
    throw new Error(`No tier found for MRR ${mrrUsdMinor}`)
  }

  if (!biasLow) return natural.key

  // Bias-low: if we're within BAND_EDGE_BIAS_PCT of just crossing into
  // this band from below, stay in the lower band. The "boundary" the
  // bias is measured against is the natural band's MIN (i.e. the round
  // figure $50,000 / $250,000 / $1,000,000), not the lower band's max
  // (which is a cent below). Matches user intuition: "$52,499 → Starter,
  // $52,500 → Growth" for the Starter→Growth boundary.
  const lowerBand = TIERS[TIERS.findIndex((t) => t.key === natural.key) - 1]
  if (!lowerBand) return natural.key

  const biasedUpperBound = Math.floor(
    natural.minUsdMinor * (1 + BAND_EDGE_BIAS_PCT),
  )
  if (mrrUsdMinor < biasedUpperBound) return lowerBand.key

  return natural.key
}

/**
 * Tier rank — lower = cheaper, higher = more expensive. Used to compare
 * recommended vs billed (upgrade vs downgrade).
 */
export function tierRank(tier: TierKey): number {
  return TIERS.findIndex((t) => t.key === tier)
}

/**
 * Returns the tier the customer SHOULD be on, accounting for downgrade
 * hysteresis. Anti-seesaw: a billed-Growth customer stays on Growth until
 * their MRR drops below the boundary minus DOWNGRADE_HYSTERESIS_PCT.
 *
 * Used by tier-transitions.ts on the mid-life recompute path. NOT used at
 * first activation (use tierFromMrr with biasLow there).
 */
export function tierFromMrrWithHysteresis(
  mrrUsdMinor: number,
  currentBilledTier: TierKey | null,
): TierKey {
  const naturalTier = tierFromMrr(mrrUsdMinor)

  // No current billed tier → just use the natural tier.
  if (!currentBilledTier) return naturalTier

  // If the natural tier is higher or equal to current, no downgrade
  // pressure — return whichever is higher (upgrade pressure is the
  // caller's concern, gated separately).
  if (tierRank(naturalTier) >= tierRank(currentBilledTier)) return naturalTier

  // Downgrade pressure: stay on currentBilledTier unless MRR has dropped
  // past the hysteresis threshold beneath the current band's lower bound.
  const current = tierConfig(currentBilledTier)
  const hysteresisFloor = Math.floor(
    current.minUsdMinor * (1 - DOWNGRADE_HYSTERESIS_PCT),
  )
  if (mrrUsdMinor < hysteresisFloor) return naturalTier
  return currentBilledTier
}

/**
 * Resolves the Stripe Price ID for a tier.
 *
 * Resolution order:
 *   1. Env var (STRIPE_PRICE_ID_STARTER/GROWTH/SCALE) — preferred for
 *      production so the Price is operator-visible in the Stripe dashboard.
 *   2. Existing Price by lookup_key.
 *   3. Create Product + Price on demand (non-production / first-run).
 *
 * Enterprise has no Price ID — it's sales-handled.
 */
export async function tierPriceId(
  stripe: Stripe,
  tier: TierKey,
): Promise<string> {
  if (tier === 'enterprise') {
    throw new Error('Enterprise tier has no Stripe Price ID — sales-handled')
  }

  const cfg = tierConfig(tier)
  if (cfg.priceUsdMinor === null || cfg.lookupKey === null) {
    throw new Error(`Tier ${tier} is missing price config`)
  }

  const envKey = `STRIPE_PRICE_ID_${tier.toUpperCase()}`
  const fromEnv = process.env[envKey]
  if (fromEnv) return fromEnv

  const list = await stripe.prices.list({
    lookup_keys: [cfg.lookupKey],
    active: true,
    limit: 1,
  })
  if (list.data[0]) return list.data[0].id

  const product = await stripe.products.create({
    name: `Winback ${tierLabel(tier)}`,
    metadata: { winback_role: 'platform_fee', winback_tier: tier },
  })
  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: cfg.priceUsdMinor,
    currency: 'usd',
    recurring: { interval: 'month' },
    lookup_key: cfg.lookupKey,
  })
  return price.id
}

/**
 * Reverse lookup: given a Stripe Price ID (from a platform-side subscription
 * sync), return the tier it belongs to. NULL if no match — caller must
 * decide whether that's a config drift error or a `customMonthlyCents`
 * one-off Price.
 */
export async function tierFromPriceId(
  stripe: Stripe,
  priceId: string,
): Promise<TierKey | null> {
  // Try env vars first (cheap).
  for (const cfg of TIERS) {
    const envKey = `STRIPE_PRICE_ID_${cfg.key.toUpperCase()}`
    if (process.env[envKey] === priceId) return cfg.key
  }

  // Then look up the Price by ID and match its lookup_key.
  try {
    const price = await stripe.prices.retrieve(priceId)
    const lookupKey = price.lookup_key
    if (!lookupKey) return null
    const match = TIERS.find((t) => t.lookupKey === lookupKey)
    return match ? match.key : null
  } catch {
    return null
  }
}

/**
 * Human-readable tier name for UI/email copy. Used wherever we surface a
 * tier name to the customer.
 */
export function tierLabel(tier: TierKey): string {
  switch (tier) {
    case 'starter':    return 'Starter'
    case 'growth':     return 'Growth'
    case 'scale':      return 'Scale'
    case 'enterprise': return 'Enterprise'
  }
}

/**
 * Returns the band string ("$50k – $250k") for the tier — used in the
 * transparency block.
 */
export function tierBandLabel(tier: TierKey): string {
  const cfg = tierConfig(tier)
  const min = formatUsdShort(cfg.minUsdMinor)
  if (cfg.maxUsdMinor === null) return `${min}+`
  // Display the boundary as the next band's floor for readability:
  // Starter shows "$0 – $50k" not "$0 – $49,999".
  const nextIdx = TIERS.findIndex((t) => t.key === tier) + 1
  const next = TIERS[nextIdx]
  const max = next ? formatUsdShort(next.minUsdMinor) : formatUsdShort(cfg.maxUsdMinor)
  return `${min} – ${max}`
}

function formatUsdShort(usdMinor: number): string {
  const usd = usdMinor / 100
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(usd % 1_000_000 === 0 ? 0 : 1)}M`
  if (usd >= 1_000)     return `$${(usd / 1_000).toFixed(usd % 1_000 === 0 ? 0 : 1)}k`
  return `$${usd.toFixed(0)}`
}

/**
 * Re-export config types for convenience at call sites.
 */
export type { TierKey, TierConfig }

/**
 * Billing config — single source of truth for the tiered pricing model.
 *
 * This module owns every magic number that drives tier assignment, mid-life
 * tier transitions, and the value-display block. Business logic must NEVER
 * inline these values — always import from here so a single change ripples
 * everywhere it matters (price changes, threshold tweaks, sustain-window
 * tuning).
 *
 * See: /Users/tejay/.claude/plans/we-are-going-to-memoized-kernighan.md
 */

export type TierKey = 'starter' | 'growth' | 'scale' | 'enterprise'

export type TierConfig = {
  key: TierKey
  /** Inclusive lower bound of the MRR band in USD minor units (cents). */
  minUsdMinor: number
  /** Inclusive upper bound. null = unbounded (enterprise). */
  maxUsdMinor: number | null
  /** Monthly fee in USD minor units. null = sales-handled (enterprise). */
  priceUsdMinor: number | null
  /** Stripe Price lookup_key fallback when the env var is unset. */
  lookupKey: string | null
}

/**
 * Tier ladder. Bands are inclusive of the lower bound. The upper bound is
 * inclusive on the row that declares it (so $49,999.99 is Starter,
 * $50,000.00 is Growth) — see tierFromMrr in ./tiers.ts.
 */
export const TIERS: readonly TierConfig[] = [
  {
    key: 'starter',
    minUsdMinor: 0,
    maxUsdMinor: 49_999_99,
    priceUsdMinor: 99_00,
    lookupKey: 'winback_starter_monthly_v2',
  },
  {
    key: 'growth',
    minUsdMinor: 50_000_00,
    maxUsdMinor: 249_999_99,
    priceUsdMinor: 299_00,
    lookupKey: 'winback_growth_monthly_v2',
  },
  {
    key: 'scale',
    minUsdMinor: 250_000_00,
    maxUsdMinor: 999_999_99,
    priceUsdMinor: 699_00,
    lookupKey: 'winback_scale_monthly_v2',
  },
  {
    key: 'enterprise',
    minUsdMinor: 1_000_000_00,
    maxUsdMinor: null,
    priceUsdMinor: null,
    lookupKey: null,
  },
] as const

/**
 * Bias-low rule — applies ONLY at first activation (live Stripe read).
 *
 * If computed MRR is within this fraction of an upper boundary, default to
 * the lower band. Concretely: at the Starter→Growth boundary ($50,000), a
 * customer at $49,999 stays in Starter; at $52,499 also stays Starter; at
 * $52,500 they become Growth.
 *
 * Mid-life tier transitions use hysteresis instead (DOWNGRADE_HYSTERESIS_PCT),
 * not bias-low — different mechanism for a different invariant.
 */
export const BAND_EDGE_BIAS_PCT = 0.05

/**
 * Hysteresis on downgrades only — anti-seesaw for boundary-camping customers.
 *
 * A billed Growth customer is downgraded to Starter only if smoothed MRR drops
 * below $50,000 × (1 - 0.10) = $45,000 (and stays there for the sustain
 * window). Without this, a customer wobbling around $50k MRR would flap
 * between Growth and Starter every cycle.
 *
 * Applies to downgrades only. Upgrades use the strict band boundary so a
 * customer climbing into a higher band gets prompted promptly.
 */
export const DOWNGRADE_HYSTERESIS_PCT = 0.10

/**
 * Trailing-window length for the smoothed-MRR median used in mid-life tier
 * decisions. The cron uses all snapshots within this window (could be fewer
 * than one-per-day given the weekly cadence; webhook-driven snapshots add
 * density).
 */
export const SMOOTHING_WINDOW_DAYS = 30

/**
 * Smoothed MRR must remain in a higher band for this many days before the
 * upgrade prompt fires. Tracked via the recommended_changed_at timestamp —
 * only an actual band change updates it, so flapping is naturally damped.
 */
export const UPGRADE_SUSTAIN_DAYS = 14

/**
 * Smoothed MRR must remain in a lower band (past the hysteresis threshold)
 * for this many days before the downgrade prompt fires. Longer than upgrade
 * to be customer-friendly — we don't yank service down on a transient dip.
 */
export const DOWNGRADE_SUSTAIN_DAYS = 30

/**
 * Window for the "Recovered (last N days)" figure in the transparency block.
 */
export const ROI_DISPLAY_WINDOW_DAYS = 30

/**
 * If the cached FX rate is older than this, the MRR computation uses it
 * anyway but emits an admin alert. Failing-closed on FX would block
 * activation for global customers — the better tradeoff is to use the stale
 * rate (rarely enough movement to cross a tier band) and surface it to ops.
 */
export const FX_STALENESS_ALERT_DAYS = 7

/**
 * Tolerance for reconciling our computed MRR against Stripe's Analytics API
 * figure (when the Connect probe succeeds). Beyond this, fire an admin
 * alert; do NOT change the customer-facing tier on divergence.
 */
export const MRR_RECONCILIATION_ALERT_PCT = 0.05

/**
 * Throws if a tier key is unknown — defends against typos at call sites.
 */
export function tierConfig(key: TierKey): TierConfig {
  const found = TIERS.find((t) => t.key === key)
  if (!found) throw new Error(`Unknown tier key: ${key}`)
  return found
}

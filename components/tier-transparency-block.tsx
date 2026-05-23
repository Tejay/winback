/**
 * TierTransparencyBlock — the dispute-proof billing surface.
 *
 * Renders the customer's MRR, tier band, monthly fee, trailing-30d
 * recovered figure, and ROI ratio in a single shared component used on:
 *   - the activation confirmation page (before they subscribe)
 *   - the dashboard (always visible)
 *   - settings (alongside payment method + invoices)
 *
 * The breakdown panel shows the per-currency, per-status math so the
 * customer can verify our number against their own Stripe dashboard.
 * That cross-check is the anti-dispute armor: if our compute is wrong,
 * they spot it before any charge.
 *
 * Pure presentation — fetches no data, takes everything as props. Server
 * components or client components can mount it. Data shape mirrors the
 * /api/billing/activation-preview response.
 */

import { tierBandLabel, tierLabel, type TierKey } from '@/src/winback/lib/tiers'

export interface TierTransparencyData {
  /** 'custom' for flat-rate carve-out customers; tier key otherwise. */
  tier: TierKey | 'custom' | 'enterprise' | null
  /** USD minor units (cents). null when no tier is assigned yet. */
  priceUsdMinor: number | null
  /** USD minor units. */
  mrrUsdMinor: number
  /** USD minor units. Sum of strong+weak attribution recoveries in last 30d. */
  trailing30dRecoveredUsdMinor: number
  /** Optional Stripe-Analytics second opinion; null when unavailable. */
  stripeReportedMrrUsdMinor?: number | null
  /** Subscription counts per status for the breakdown panel. */
  breakdown?: {
    activeSubscriptionCount: number
    pastDueSubscriptionCount: number
    excludedTrialingCount: number
    excludedCanceledCount: number
    excludedOtherCount?: number
    skippedMissingFxCount?: number
  }
  /** Per-currency contribution in NATIVE minor units. */
  perCurrency?: Record<string, number>
}

/**
 * `showRecoveryBlock` controls whether the "Recovered (last 30 days)" +
 * "ROI" rows render. Off on the dashboard (avoids the "ROI 0.0×" embarrassment
 * for accounts with low recent recoveries — they can see the same numbers
 * on settings). On wherever it does show, the ROI row itself only renders
 * when the ratio is >= 1.0 (i.e., when WinbackFlow has paid for itself this
 * month). Below 1.0 the row is hidden — never display a sub-1× multiple,
 * it's worse marketing than showing nothing.
 */
export function TierTransparencyBlock({
  data,
  showRecoveryBlock = true,
}: {
  data: TierTransparencyData
  showRecoveryBlock?: boolean
}) {
  const isEnterprise = data.tier === 'enterprise'
  const isCustom = data.tier === 'custom'
  const tierName =
    data.tier === null
      ? '—'
      : isCustom
        ? 'Custom plan'
        : tierLabel(data.tier as TierKey)
  const bandLabel =
    data.tier === null || isCustom || isEnterprise
      ? null
      : tierBandLabel(data.tier as TierKey)

  const roiRatio =
    data.priceUsdMinor && data.priceUsdMinor > 0
      ? data.trailing30dRecoveredUsdMinor / data.priceUsdMinor
      : null

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold text-slate-700">Your account</h3>

      <dl className="space-y-2 text-sm">
        <Row
          label="MRR (computed)"
          value={
            <span className="tabular-nums">
              {formatUsd(data.mrrUsdMinor)} USD
              {data.stripeReportedMrrUsdMinor != null && (
                <span className="ml-2 text-xs text-slate-500">
                  Stripe reports: {formatUsd(data.stripeReportedMrrUsdMinor)} ✓
                </span>
              )}
            </span>
          }
        />
        <Row
          label="Tier band"
          value={
            <span>
              {tierName}
              {bandLabel && <span className="ml-2 text-slate-500">({bandLabel})</span>}
            </span>
          }
        />
        <Row
          label="Your fee"
          value={
            isEnterprise
              ? 'Contact sales'
              : data.priceUsdMinor != null
                ? `${formatUsd(data.priceUsdMinor)} / mo`
                : '—'
          }
        />
      </dl>

      {showRecoveryBlock && (
        <>
          <hr className="my-3 border-slate-100" />
          <dl className="space-y-2 text-sm">
            <Row
              label="Recovered (last 30 days)"
              value={
                <span className="tabular-nums">
                  {formatUsd(data.trailing30dRecoveredUsdMinor)}
                </span>
              }
            />
            {roiRatio !== null && roiRatio >= 1 && (
              <Row
                label="ROI"
                value={
                  <span className="tabular-nums">
                    {roiRatio.toFixed(1)}× your fee
                  </span>
                }
              />
            )}
          </dl>
        </>
      )}

      {data.breakdown && (
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-700">
            View calculation
          </summary>
          <div className="mt-2 space-y-1 text-xs text-slate-600">
            <div>Active subscriptions: {data.breakdown.activeSubscriptionCount}</div>
            <div>Past-due subscriptions: {data.breakdown.pastDueSubscriptionCount}</div>
            {data.breakdown.excludedTrialingCount > 0 && (
              <div>Trialing (excluded): {data.breakdown.excludedTrialingCount}</div>
            )}
            {data.breakdown.excludedCanceledCount > 0 && (
              <div>Canceled (excluded): {data.breakdown.excludedCanceledCount}</div>
            )}
            {(data.breakdown.excludedOtherCount ?? 0) > 0 && (
              <div>
                Other excluded statuses: {data.breakdown.excludedOtherCount}
              </div>
            )}
            {(data.breakdown.skippedMissingFxCount ?? 0) > 0 && (
              <div className="text-amber-700">
                Skipped (no FX rate): {data.breakdown.skippedMissingFxCount}
              </div>
            )}
            {data.perCurrency && Object.keys(data.perCurrency).length > 1 && (
              <div className="pt-2">
                <div className="font-medium text-slate-700">Per currency (native):</div>
                {Object.entries(data.perCurrency).map(([code, minor]) => (
                  <div key={code}>
                    {code.toUpperCase()}: {formatNativeMinor(minor, code)}
                  </div>
                ))}
              </div>
            )}
            <div className="pt-2 text-slate-500">
              Verify against your Stripe dashboard → Billing → Subscriptions overview.
            </div>
          </div>
        </details>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  )
}

function formatUsd(minor: number): string {
  return `$${(minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

function formatNativeMinor(minor: number, currency: string): string {
  // Most currencies we care about use 2 decimal places; this is a display
  // approximation only (zero-decimal currencies like JPY would render
  // slightly off but are extremely rare in our cohort).
  return `${currency.toUpperCase()} ${(minor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

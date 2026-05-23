/**
 * FX rate fetching + caching.
 *
 * MRR computation needs to convert non-USD subscription amounts into USD
 * to assign a tier. We pull rates from a single chosen daily provider,
 * cache them in `wb_fx_rates`, and refresh them daily via cron.
 *
 * Failure modes (matters because tier assignment depends on these):
 *   - USD lookup → always returns 1.0 (short-circuit, never hits provider).
 *   - Cache hit, fresh (<7d) → returns cached value.
 *   - Cache hit, stale (>=7d) → returns cached value AND emits admin alert.
 *     Rationale: failing-closed on FX blocks global customers from
 *     activating, and 7d of rate movement rarely shifts a tier band.
 *   - Cache miss (never fetched) → returns null. Caller (mrr.ts) skips that
 *     subscription's contribution and emits an admin alert.
 *
 * Never silently convert at a fabricated rate.
 */

import { db } from '@/lib/db'
import { fxRates } from '@/lib/schema'
import { eq, sql } from 'drizzle-orm'
import { FX_STALENESS_ALERT_DAYS } from './billing-config'

const PROVIDER_URL = 'https://open.er-api.com/v6/latest/USD'

export type FxLookupResult =
  | { ok: true; rateUsd: number; stale: boolean }
  | { ok: false; reason: 'missing' }

/**
 * Returns the most recent cached USD rate for `currency`. Returns null
 * (not throwing) on cache miss — callers handle that explicitly.
 *
 * Logs structured warnings on stale cache hits but does not throw; rate
 * movement over 7 days is rarely enough to cross a tier band.
 */
export async function getUsdRate(currency: string): Promise<FxLookupResult> {
  const code = currency.toLowerCase()
  if (code === 'usd') return { ok: true, rateUsd: 1, stale: false }

  const rows = await db
    .select()
    .from(fxRates)
    .where(eq(fxRates.currency, code))
    .limit(1)

  const row = rows[0]
  if (!row) {
    console.warn('[fx] missing rate', { currency: code })
    return { ok: false, reason: 'missing' }
  }

  const ageDays =
    (Date.now() - new Date(row.fetchedAt).getTime()) / (1000 * 60 * 60 * 24)
  const stale = ageDays >= FX_STALENESS_ALERT_DAYS
  if (stale) {
    console.warn('[fx] stale rate, using anyway', {
      currency: code,
      ageDays: Math.round(ageDays),
    })
  }

  // drizzle returns NUMERIC as string — parse to number for math.
  const rateUsd = Number(row.rateUsd)
  return { ok: true, rateUsd, stale }
}

/**
 * Refresh ALL FX rates from the provider, upserting into wb_fx_rates.
 * Called by the daily fx-refresh cron and on-demand from the bootstrap
 * path (so a brand-new install has rates before the first MRR snapshot).
 *
 * The provider returns rates as USD-base (1 USD = X foreign). MRR is
 * computed in native currency then divided by that rate to get USD —
 * see mrr.ts. We store the provider's rate directly (USD→FOREIGN).
 */
export async function refreshAllRates(): Promise<
  | { ok: true; currenciesUpdated: number }
  | { ok: false; error: string }
> {
  let payload: { rates?: Record<string, number>; result?: string }
  try {
    const res = await fetch(PROVIDER_URL, { cache: 'no-store' })
    if (!res.ok) {
      return { ok: false, error: `provider HTTP ${res.status}` }
    }
    payload = await res.json() as typeof payload
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (payload.result !== 'success' || !payload.rates) {
    return { ok: false, error: 'provider returned unexpected payload shape' }
  }

  const now = new Date()
  let count = 0
  for (const [code, rate] of Object.entries(payload.rates)) {
    if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) continue
    const lower = code.toLowerCase()
    if (lower === 'usd') continue
    await db
      .insert(fxRates)
      .values({ currency: lower, rateUsd: String(rate), fetchedAt: now })
      .onConflictDoUpdate({
        target: fxRates.currency,
        set: { rateUsd: String(rate), fetchedAt: now },
      })
    count += 1
  }
  return { ok: true, currenciesUpdated: count }
}

/**
 * Converts a native-minor amount in `currency` to USD-minor units.
 *
 * Returns null when the rate is unavailable (missing) — caller (mrr.ts)
 * must skip that contribution and emit an alert. Stale rates DO convert;
 * the warning is emitted inside getUsdRate.
 */
export async function convertToUsdMinor(
  nativeMinor: number,
  currency: string,
): Promise<number | null> {
  const lookup = await getUsdRate(currency)
  if (!lookup.ok) return null
  // Provider rate is USD→foreign; to go foreign→USD we divide.
  // nativeMinor / rate gives USD in the same minor units (cents-ish; both
  // currencies use 2 decimals for the currencies we care about).
  return Math.round(nativeMinor / lookup.rateUsd)
}

/**
 * Force-set a rate. Test-only helper; not exported through any index.
 */
export async function _testSetRate(
  currency: string,
  rateUsd: number,
  fetchedAt: Date = new Date(),
): Promise<void> {
  const lower = currency.toLowerCase()
  await db
    .insert(fxRates)
    .values({ currency: lower, rateUsd: String(rateUsd), fetchedAt })
    .onConflictDoUpdate({
      target: fxRates.currency,
      set: { rateUsd: String(rateUsd), fetchedAt },
    })
}

/** No-op import to make sql usable when needed. */
export const _sqlMarker = sql

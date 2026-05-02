/**
 * Spec 39 — Pure helpers for /api/stats.
 *
 * The route does the SQL aggregations; this module hosts the
 * recoveryType / time-window bucketing logic and the recovery-rate
 * calculation so they can be unit-tested without mocking the DB.
 */

export type Bucket = { recovered: number; mrrRecoveredCents: number }

export type RecoveryAggRow = {
  recoveryType: string | null      // 'win_back' | 'card_save' | null (legacy)
  isThisMonth: boolean
  count: number
  mrrCents: number
}

export type AggregatedRecoveries = {
  winBackThisMonth: Bucket
  winBackAllTime: Bucket
  paymentThisMonth: Bucket
  paymentAllTime: Bucket
  legacyNullCount: number          // for telemetry: rows pre-Spec 18 with NULL recoveryType
}

/** Start of the current month at 00:00:00 UTC. */
export function startOfMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

/** Start of the previous month at 00:00:00 UTC. */
export function startOfPrevMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0))
}

/**
 * Spec 40 — Build a 30-bucket daily series ending today (UTC).
 *
 * Given the raw rows ({ day: 'YYYY-MM-DD', count }) returned from a
 * date-truncated GROUP BY query, fill in zeros for any missing days so
 * the sparkline renders a continuous trend with no gaps.
 *
 * Returns oldest → newest, length 30. The dashboard SVG sparkline reads
 * the array in order.
 */
export function buildDailySeries(
  rows: Array<{ day: string; count: number }>,
  days: number = 30,
  now: Date = new Date(),
): number[] {
  const byDay = new Map<string, number>()
  for (const r of rows) byDay.set(r.day, Number(r.count))

  const out: number[] = []
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000)
    const key = d.toISOString().slice(0, 10) // YYYY-MM-DD
    out.push(byDay.get(key) ?? 0)
  }
  return out
}

/**
 * Recovery rate as a 0–100 integer.
 *
 * Spec 39 amendment (2026-05-02) — was `recovered / (recovered + lost)`,
 * a conversion-rate-among-decided-outcomes. That denominator excluded
 * in-flight rows and read as broken math against the cohort table
 * below ("8 recovered out of a 22-row cohort, but rate says 67%?").
 *
 * Now: pass the **cohort total** (the actual denominator the merchant
 * sees in the table) and the recovered count out of that cohort. The
 * route scopes both to a rolling 30-day window, so the rate is
 * "of customers who churned in the last 30 days, X% have come back."
 *
 * Returns null when the cohort is empty (avoids the "0% of 0
 * customers" read).
 */
export function recoveryRatePct(
  recovered: number,
  cohortTotal: number,
): number | null {
  if (cohortTotal === 0) return null
  return Math.round((recovered / cohortTotal) * 100)
}

/**
 * Spec 40 — Pattern-strip helper. Given a list of (label, count)
 * pairs, return the top N as percentages of the total.
 *
 * - Returns [] when there are no rows, or when the total is below
 *   `minTotal` (sample-size guard — avoids "100%" claims on a 1-row
 *   sample when the strip's window is sparse).
 * - Sorts by count DESC, falls back to alphabetical for ties so the
 *   order is deterministic across renders.
 * - Drops null/empty labels (DB rows with no category yet).
 * - Percentages are rounded ints; rounding error may push the sum
 *   off by ±1, which is acceptable for a UI strip.
 */
export type LabelCount = { label: string | null; count: number }
export type LabelPct = { label: string; pct: number }

export function topNFromCounts(
  rows: LabelCount[],
  n: number,
  opts: { minTotal?: number } = {},
): LabelPct[] {
  const total = rows.reduce((s, r) => s + r.count, 0)
  const minTotal = opts.minTotal ?? 1
  if (total < minTotal) return []

  const cleaned = rows
    .filter((r) => r.label && r.count > 0)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return (a.label ?? '').localeCompare(b.label ?? '')
    })
    .slice(0, n)

  return cleaned.map((r) => ({
    label: r.label as string,
    pct: Math.round((r.count / total) * 100),
  }))
}

/**
 * Bucket grouped recovery rows into win-back vs payment-recovery,
 * each split by this-month vs all-time.
 *
 * Defensive: rows with a null recoveryType are bucketed as win-back
 * (the original assumption pre-Spec 18) and counted in
 * `legacyNullCount` so the route can log a single warning.
 */
export function aggregateRecoveryRows(rows: RecoveryAggRow[]): AggregatedRecoveries {
  const result: AggregatedRecoveries = {
    winBackThisMonth: { recovered: 0, mrrRecoveredCents: 0 },
    winBackAllTime: { recovered: 0, mrrRecoveredCents: 0 },
    paymentThisMonth: { recovered: 0, mrrRecoveredCents: 0 },
    paymentAllTime: { recovered: 0, mrrRecoveredCents: 0 },
    legacyNullCount: 0,
  }

  for (const row of rows) {
    const count = Number(row.count)
    const mrr = Number(row.mrrCents)

    if (row.recoveryType === 'card_save') {
      result.paymentAllTime.recovered += count
      result.paymentAllTime.mrrRecoveredCents += mrr
      if (row.isThisMonth) {
        result.paymentThisMonth.recovered += count
        result.paymentThisMonth.mrrRecoveredCents += mrr
      }
    } else {
      // 'win_back' or NULL/unknown → bucket as win-back
      if (row.recoveryType === null) result.legacyNullCount += count
      result.winBackAllTime.recovered += count
      result.winBackAllTime.mrrRecoveredCents += mrr
      if (row.isThisMonth) {
        result.winBackThisMonth.recovered += count
        result.winBackThisMonth.mrrRecoveredCents += mrr
      }
    }
  }

  return result
}

/**
 * MRR snapshots — orchestrates compute + persistence + smoothing.
 *
 * `takeSnapshot` reads the customer's Stripe (via their stored OAuth
 * access token), runs computeMrrFromStripe, optionally fetches Stripe's
 * own reported MRR for reconciliation, and writes one row to
 * wb_mrr_snapshots.
 *
 * `computeSmoothed` returns the trailing 30-day median of available
 * snapshots — used by the tier-transitions evaluator. With weekly cron +
 * webhook-driven snapshots, a typical 30d window has 8-15 data points.
 *
 * Errors from the Stripe API are swallowed at this layer: failing to
 * snapshot a single account must not break the cron run for everyone
 * else. The caller (cron / webhook handler) gets back a result object,
 * not an exception.
 */

import { db } from '@/lib/db'
import { customers, mrrSnapshots } from '@/lib/schema'
import { and, desc, eq, gte } from 'drizzle-orm'
import { decrypt } from './encryption'
import { computeMrrFromStripe, type MrrBreakdown, type MrrPerCurrency } from './mrr'
import { fetchStripeReportedMrr } from './mrr-stripe-analytics'
import {
  SMOOTHING_WINDOW_DAYS,
  MRR_RECONCILIATION_ALERT_PCT,
} from './billing-config'

export type SnapshotSource = 'weekly_cron' | 'webhook' | 'activation_live_read'

export type SnapshotResult =
  | {
      ok: true
      mrrUsdMinor: number
      perCurrency: MrrPerCurrency
      breakdown: MrrBreakdown
      stripeReportedMrrUsdMinor: number | null
    }
  | { ok: false; reason: 'no_token' | 'compute_error'; error?: string }

/**
 * Compute + persist a snapshot for `customerId`. Returns the snapshot
 * data on success; never throws.
 *
 * Skips silently with `no_token` if the customer has not yet connected
 * Stripe (no encrypted access token). This is the expected state for
 * brand-new signups pre-OAuth and should not log loudly.
 *
 * `dryRun`: when true, runs every step (Stripe read, FX conversion,
 * reconciliation check) EXCEPT the final wb_mrr_snapshots INSERT. Used
 * by the cron's preview mode so ops can see what would be written
 * without actually writing it.
 */
export async function takeSnapshot(
  customerId: string,
  source: SnapshotSource,
  opts: { dryRun?: boolean } = {},
): Promise<SnapshotResult> {
  const rows = await db
    .select({
      stripeAccountId: customers.stripeAccountId,
      stripeAccessToken: customers.stripeAccessToken,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)

  const row = rows[0]
  if (!row?.stripeAccessToken || !row.stripeAccountId) {
    return { ok: false, reason: 'no_token' }
  }

  let accessToken: string
  try {
    accessToken = decrypt(row.stripeAccessToken)
  } catch (err) {
    return {
      ok: false,
      reason: 'compute_error',
      error: `decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  let mrr: Awaited<ReturnType<typeof computeMrrFromStripe>>
  try {
    mrr = await computeMrrFromStripe(accessToken)
  } catch (err) {
    return {
      ok: false,
      reason: 'compute_error',
      error: err instanceof Error ? err.message : String(err),
    }
  }

  // Second-opinion lookup against Stripe's Analytics API. Never blocks
  // the snapshot — null on any failure, including unsupported.
  const stripeReportedMrrUsdMinor = await fetchStripeReportedMrr(
    row.stripeAccountId,
  )

  // Reconciliation alert. Don't change customer-facing tier on divergence
  // — just log loudly so engineering investigates. Threshold is
  // intentionally generous (5%) — Stripe's MRR is delayed ~1h vs our
  // live read, so small drift is expected.
  if (
    stripeReportedMrrUsdMinor !== null &&
    mrr.totalUsdMinor > 0 &&
    relativeDivergence(mrr.totalUsdMinor, stripeReportedMrrUsdMinor) >
      MRR_RECONCILIATION_ALERT_PCT
  ) {
    console.warn('[mrr-snapshot] reconciliation divergence', {
      customerId,
      ours: mrr.totalUsdMinor,
      stripe: stripeReportedMrrUsdMinor,
      divergencePct: relativeDivergence(
        mrr.totalUsdMinor,
        stripeReportedMrrUsdMinor,
      ).toFixed(3),
    })
  }

  if (!opts.dryRun) {
    await db.insert(mrrSnapshots).values({
      customerId,
      mrrUsdMinor: mrr.totalUsdMinor,
      perCurrency: mrr.perCurrency,
      breakdown: mrr.breakdown,
      stripeReportedMrrUsdMinor,
      source,
    })
  }

  return {
    ok: true,
    mrrUsdMinor: mrr.totalUsdMinor,
    perCurrency: mrr.perCurrency,
    breakdown: mrr.breakdown,
    stripeReportedMrrUsdMinor,
  }
}

/**
 * Trailing-window median of MRR snapshots for `customerId`. Returns null
 * if there are no snapshots in the window yet (brand-new account).
 *
 * Window length comes from SMOOTHING_WINDOW_DAYS (default 30). Uses ALL
 * snapshots within the window — both cron-scheduled and webhook-driven —
 * so density varies but the median stays stable.
 */
export async function computeSmoothed(
  customerId: string,
): Promise<number | null> {
  const windowStart = new Date(
    Date.now() - SMOOTHING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  )

  const rows = await db
    .select({ value: mrrSnapshots.mrrUsdMinor })
    .from(mrrSnapshots)
    .where(
      and(
        eq(mrrSnapshots.customerId, customerId),
        gte(mrrSnapshots.takenAt, windowStart),
      ),
    )
    .orderBy(desc(mrrSnapshots.takenAt))

  if (rows.length === 0) return null

  const values = rows.map((r) => r.value).sort((a, b) => a - b)
  return median(values)
}

function median(sortedAsc: number[]): number {
  const n = sortedAsc.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  if (n % 2 === 1) return sortedAsc[mid]
  return Math.floor((sortedAsc[mid - 1] + sortedAsc[mid]) / 2)
}

function relativeDivergence(a: number, b: number): number {
  const base = Math.max(Math.abs(a), Math.abs(b))
  if (base === 0) return 0
  return Math.abs(a - b) / base
}

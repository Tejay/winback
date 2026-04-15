import { db } from '@/lib/db'
import { customers, recoveries } from '@/lib/schema'
import { and, eq, gt } from 'drizzle-orm'

/**
 * Winback bills 15% of recovered subscriber revenue for up to 12 months per
 * recovered subscriber (`/terms` §3, `/faq` §12). Deleting the workspace
 * does not waive that obligation — this helper calculates the total still
 * owed so the delete flow can gate on it.
 */
export const SUCCESS_FEE_RATE = 0.15
export const MAX_ATTRIBUTION_MONTHS = 12

/**
 * Months of billing left on an attribution window.
 *
 * We round UP — partial months are billed whole (matches how we invoice) —
 * and clamp to [0, 12] so a future bug that writes a wrong
 * `attributionEndsAt` can't inflate a settlement quote.
 *
 * `now` is injected so tests are deterministic and callers can quote against
 * a specific invoice date (e.g. "as of today").
 */
export function monthsRemaining(attributionEndsAt: Date, now: Date = new Date()): number {
  const msPerDay = 1000 * 60 * 60 * 24
  const daysLeft = (attributionEndsAt.getTime() - now.getTime()) / msPerDay
  if (daysLeft <= 0) return 0
  const months = Math.ceil(daysLeft / 30)
  return Math.min(months, MAX_ATTRIBUTION_MONTHS)
}

/**
 * Fee owed on a single recovery line, in integer cents.
 * Inactive recoveries (subscriber cancelled again) owe nothing going forward.
 */
export function obligationForRecovery(
  recovery: { planMrrCents: number; attributionEndsAt: Date; stillActive: boolean | null },
  now: Date = new Date(),
): number {
  if (!recovery.stillActive) return 0
  const months = monthsRemaining(recovery.attributionEndsAt, now)
  // Integer maths — keeps us clear of float drift on fractional pence.
  // 15% → multiply by 15, divide by 100.
  return Math.round((recovery.planMrrCents * 15 * months) / 100)
}

export function sumObligations(
  rows: Array<{ planMrrCents: number; attributionEndsAt: Date; stillActive: boolean | null }>,
  now: Date = new Date(),
): number {
  return rows.reduce((acc, r) => acc + obligationForRecovery(r, now), 0)
}

/**
 * DB-backed wrapper. Returns live, in-window recoveries plus the aggregate
 * obligation. Callers render this on `/settings/delete` (Gate 0) and
 * re-check it on `/api/settings/delete` before performing the delete.
 */
export async function computeOpenObligations(
  customerId: string,
  now: Date = new Date(),
): Promise<{
  openObligationCents: number
  liveCount: number
  earliestEndsAt: Date | null
  latestEndsAt: Date | null
  settlementPaidAt: Date | null
}> {
  // If the merchant has already paid out their attribution obligations via
  // Stripe Checkout, short-circuit — they owe nothing regardless of live
  // recoveries. Gates 1-3 on /settings/delete unlock as a result.
  const [c] = await db
    .select({ settlementPaidAt: customers.settlementPaidAt })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)
  if (c?.settlementPaidAt) {
    return {
      openObligationCents: 0,
      liveCount: 0,
      earliestEndsAt: null,
      latestEndsAt: null,
      settlementPaidAt: c.settlementPaidAt,
    }
  }

  const rows = await db
    .select({
      planMrrCents: recoveries.planMrrCents,
      attributionEndsAt: recoveries.attributionEndsAt,
      stillActive: recoveries.stillActive,
    })
    .from(recoveries)
    .where(
      and(
        eq(recoveries.customerId, customerId),
        eq(recoveries.stillActive, true),
        gt(recoveries.attributionEndsAt, now),
      ),
    )

  const openObligationCents = sumObligations(rows, now)
  const liveCount = rows.length
  const dates = rows.map((r) => r.attributionEndsAt.getTime()).sort((a, b) => a - b)

  return {
    openObligationCents,
    liveCount,
    earliestEndsAt: dates.length ? new Date(dates[0]) : null,
    latestEndsAt: dates.length ? new Date(dates[dates.length - 1]) : null,
    settlementPaidAt: null,
  }
}

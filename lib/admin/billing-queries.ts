/**
 * Aggregation queries for /admin/billing — slimmed for the tiered platform
 * fee model. The performance-fee subsystem was removed in the billing
 * rewrite (no per-recovery charges anymore), so the queries that listed
 * outstanding obligations and charged perf fees are gone.
 *
 * What remains: the 13-week MRR-recovered trend (still useful — shows
 * customer-side recovered MRR over time, not platform billing).
 *
 * /admin/billing's perf-fee blocks are gone too; if/when admin needs a
 * tier-distribution view, add a tierDistribution() query here.
 */

import { sql, gte } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { recoveries } from '../schema'

/** Test-vs-live mode for building Stripe Dashboard URLs in the admin UI. */
export function detectStripeMode(): 'test' | 'live' {
  const key = process.env.STRIPE_SECRET_KEY ?? ''
  return key.startsWith('sk_live_') ? 'live' : 'test'
}

/**
 * Weekly MRR-recovered trend, split by attribution type. Powers the
 * stacked-bar chart at the bottom of /admin/billing.
 */
export async function mrrRecoveredWeeklyTrend(weeks = 13): Promise<Array<{
  week: string
  attributionType: string
  cents: number
  n: number
}>> {
  const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000)
  const rows = await getDbReadOnly()
    .select({
      week: sql<string>`to_char(date_trunc('week', ${recoveries.recoveredAt}), 'YYYY-MM-DD')`,
      attributionType: recoveries.attributionType,
      cents: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::bigint`,
      n: sql<number>`count(*)::int`,
    })
    .from(recoveries)
    .where(gte(recoveries.recoveredAt, since))
    .groupBy(sql`date_trunc('week', ${recoveries.recoveredAt})`, recoveries.attributionType)
    .orderBy(sql`date_trunc('week', ${recoveries.recoveredAt})`)

  return rows.map((r) => ({
    week: r.week,
    attributionType: r.attributionType ?? 'organic',
    cents: Number(r.cents),
    n: r.n,
  }))
}

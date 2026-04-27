/**
 * Phase C — Aggregation queries for /admin/billing, slimmed for the new
 * Stripe-Subscription-driven billing model.
 *
 * Two blocks: queued win-back fees (recovery rows that haven't been billed
 * yet — typically waiting for a card) and the 13-week MRR-recovered trend.
 *
 * The old per-period billing_runs status breakdown and failed-run retry
 * dashboard are gone; Stripe Subscriptions handle their own dunning.
 */

import { sql, and, eq, desc, gte, isNull } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { customers, users, recoveries } from '../schema'

export interface OutstandingObligationRow {
  recoveryId: string
  customerId: string
  recoveredAt: Date | null
  planMrrCents: number
  feeCents: number
  period: string
  productName: string | null
  customerEmail: string | null
}

/**
 * Win-back recoveries with a performance fee owed but not yet charged
 * (typically because the customer hasn't added a card yet, so the Stripe
 * Subscription couldn't be created and the fee is queued in the DB).
 *
 * Once the customer activates (card lands → ensureActivation drains the
 * queue), perf_fee_charged_at gets stamped and the row drops off this list.
 */
export async function outstandingObligations(): Promise<OutstandingObligationRow[]> {
  const rows = await getDbReadOnly()
    .select({
      recoveryId:    recoveries.id,
      customerId:    recoveries.customerId,
      recoveredAt:   recoveries.recoveredAt,
      planMrrCents:  recoveries.planMrrCents,
      productName:   customers.productName,
      customerEmail: users.email,
      period:        sql<string>`to_char(${recoveries.recoveredAt}, 'YYYY-MM')`,
    })
    .from(recoveries)
    .innerJoin(customers, eq(customers.id, recoveries.customerId))
    .innerJoin(users, eq(users.id, customers.userId))
    .where(and(
      eq(recoveries.attributionType, 'strong'),
      eq(recoveries.recoveryType, 'win_back'),
      isNull(recoveries.perfFeeChargedAt),
      isNull(recoveries.perfFeeRefundedAt),
    ))
    .orderBy(desc(recoveries.recoveredAt))

  return rows.map((r) => ({
    recoveryId: r.recoveryId,
    customerId: r.customerId,
    recoveredAt: r.recoveredAt,
    planMrrCents: r.planMrrCents,
    // Win-back fee is 1× MRR, charged once.
    feeCents: r.planMrrCents,
    period: r.period,
    productName: r.productName,
    customerEmail: r.customerEmail,
  }))
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

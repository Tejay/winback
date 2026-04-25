/**
 * Spec 26 — Aggregation queries for /admin/billing.
 *
 * Three blocks: current-period status breakdown, failed invoices (90d), and
 * outstanding obligations (strong recoveries with no paid run covering
 * their period). Plus a 90-day weekly MRR-recovered trend.
 */

import { sql, and, eq, desc, gte } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { billingRuns, customers, users, recoveries } from '../schema'

export interface BillingStatusBreakdown {
  period: string                            // current YYYY-MM
  paid: number
  pending: number
  failed: number
  skippedNoObligations: number
  skippedNoCard: number
}

/**
 * Current-period (YYYY-MM) status breakdown across wb_billing_runs.
 */
export async function currentPeriodBreakdown(): Promise<BillingStatusBreakdown> {
  const period = new Date().toISOString().slice(0, 7)  // YYYY-MM in UTC
  const rows = await getDbReadOnly()
    .select({
      status: billingRuns.status,
      n: sql<number>`count(*)::int`,
    })
    .from(billingRuns)
    .where(eq(billingRuns.periodYyyymm, period))
    .groupBy(billingRuns.status)

  const out: BillingStatusBreakdown = {
    period,
    paid: 0,
    pending: 0,
    failed: 0,
    skippedNoObligations: 0,
    skippedNoCard: 0,
  }
  for (const r of rows) {
    if (r.status === 'paid') out.paid = r.n
    else if (r.status === 'pending') out.pending = r.n
    else if (r.status === 'failed') out.failed = r.n
    else if (r.status === 'skipped_no_obligations') out.skippedNoObligations = r.n
    else if (r.status === 'skipped_no_card') out.skippedNoCard = r.n
  }
  return out
}

export interface FailedRunRow {
  id: string
  customerId: string
  periodYyyymm: string
  amountCents: number
  stripeInvoiceId: string | null
  createdAt: Date
  productName: string | null
  customerEmail: string | null
}

/**
 * Failed billing runs in the last 90 days. Each row gets a Retry button
 * in the UI that calls /api/admin/actions/billing-retry.
 */
export async function failedRuns(days = 90): Promise<FailedRunRow[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  return await getDbReadOnly()
    .select({
      id:              billingRuns.id,
      customerId:      billingRuns.customerId,
      periodYyyymm:    billingRuns.periodYyyymm,
      amountCents:     billingRuns.amountCents,
      stripeInvoiceId: billingRuns.stripeInvoiceId,
      createdAt:       billingRuns.createdAt,
      productName:     customers.productName,
      customerEmail:   users.email,
    })
    .from(billingRuns)
    .innerJoin(customers, eq(customers.id, billingRuns.customerId))
    .innerJoin(users, eq(users.id, customers.userId))
    .where(and(
      eq(billingRuns.status, 'failed'),
      gte(billingRuns.createdAt, since),
    ))
    .orderBy(desc(billingRuns.createdAt))
}

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
 * Strong recoveries that don't have a paid billing run covering their
 * recovery period. The "money we should have collected but haven't" report.
 *
 * Note: this is an approximation. The cron creates one billing_run per
 * (customer, period); if that run is paid, we assume all strong recoveries
 * for that period were billed. A failed/pending run = obligations are
 * still outstanding.
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
      eq(recoveries.stillActive, true),
      sql`NOT EXISTS (
        SELECT 1 FROM ${billingRuns} br
        WHERE br.customer_id = ${recoveries.customerId}
          AND br.status = 'paid'
          AND br.period_yyyymm = to_char(${recoveries.recoveredAt}, 'YYYY-MM')
      )`,
    ))
    .orderBy(desc(recoveries.recoveredAt))

  return rows.map((r) => ({
    recoveryId: r.recoveryId,
    customerId: r.customerId,
    recoveredAt: r.recoveredAt,
    planMrrCents: r.planMrrCents,
    feeCents: Math.round(r.planMrrCents * 0.15),
    period: r.period,
    productName: r.productName,
    customerEmail: r.customerEmail,
  }))
}

/**
 * 90-day weekly MRR-recovered trend, split by attribution type. Powers the
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

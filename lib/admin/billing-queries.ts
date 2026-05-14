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

import { sql, and, eq, desc, gte, isNull, isNotNull } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { customers, users, recoveries } from '../schema'

const REFUND_WINDOW_DAYS = 14

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

export interface ChargedPerfFeeRow {
  recoveryId: string
  customerId: string
  recoveredAt: Date | null
  chargedAt: Date | null
  refundedAt: Date | null
  stripeItemId: string | null
  feeCents: number
  planMrrCents: number
  productName: string | null
  customerEmail: string | null
  withinRefundWindow: boolean
}

/**
 * Spec 67 — the N most recent charged perf fees, no time cut-off. Drives
 * the admin Refund button + Stripe-invoice-link list. Includes refunded
 * rows so support has full context (and an audit link to the credit note).
 *
 * Admin must be able to refund any individual charge regardless of age
 * (the 14-day refund policy is a customer-facing default; support can
 * override out-of-window with a confirmation warning). LIMIT 200 caps
 * the query; when in-flight volume crosses that, add a search box.
 *
 * `withinRefundWindow` is derived server-side from
 * `perf_fee_charged_at >= NOW() - 14d AND perf_fee_refunded_at IS NULL`,
 * so the UI doesn't have to compute it.
 */
export async function chargedPerfFees(limit = 200): Promise<ChargedPerfFeeRow[]> {
  const refundCutoff = new Date(Date.now() - REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const rows = await getDbReadOnly()
    .select({
      recoveryId:    recoveries.id,
      customerId:    recoveries.customerId,
      recoveredAt:   recoveries.recoveredAt,
      chargedAt:     recoveries.perfFeeChargedAt,
      refundedAt:    recoveries.perfFeeRefundedAt,
      stripeItemId:  recoveries.perfFeeStripeItemId,
      feeCents:      recoveries.perfFeeAmountCents,
      planMrrCents:  recoveries.planMrrCents,
      productName:   customers.productName,
      customerEmail: users.email,
    })
    .from(recoveries)
    .innerJoin(customers, eq(customers.id, recoveries.customerId))
    .innerJoin(users, eq(users.id, customers.userId))
    .where(and(
      isNotNull(recoveries.perfFeeChargedAt),
      eq(recoveries.recoveryType, 'win_back'),
    ))
    .orderBy(desc(recoveries.perfFeeChargedAt))
    .limit(limit)

  return rows.map((r) => ({
    recoveryId:   r.recoveryId,
    customerId:   r.customerId,
    recoveredAt:  r.recoveredAt,
    chargedAt:    r.chargedAt,
    refundedAt:   r.refundedAt,
    stripeItemId: r.stripeItemId,
    // perf_fee_amount_cents fell back to plan_mrr_cents for ancient rows.
    feeCents:     r.feeCents ?? r.planMrrCents,
    planMrrCents: r.planMrrCents,
    productName:  r.productName,
    customerEmail: r.customerEmail,
    withinRefundWindow: !r.refundedAt && !!r.chargedAt && r.chargedAt >= refundCutoff,
  }))
}

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

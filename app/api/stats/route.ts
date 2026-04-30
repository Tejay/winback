import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { and, eq, gte, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import {
  aggregateRecoveryRows,
  recoveryRatePct,
  startOfMonthUtc,
  topNFromCounts,
  type LabelPct,
  type RecoveryAggRow,
} from '@/src/winback/lib/stats'

/**
 * Spec 39 — Dashboard KPIs split by recovery type and time window.
 *
 * Two cohorts:
 *   - winBack         → recoveries.recoveryType = 'win_back'
 *   - paymentRecovery → recoveries.recoveryType = 'card_save'
 *     (internal value; merchant-facing copy says "payment recovery")
 *
 * Two time windows:
 *   - thisMonth: recovered since the start of the current UTC month
 *   - allTime:   no time filter
 *
 * Plus current-state counters (no time window):
 *   - winBack.inProgress    = churnedSubscribers.status='contacted'
 *                              AND cancellationReason != 'Payment failed'
 *   - paymentRecovery.inDunning = dunningState in
 *                              ('awaiting_retry','final_retry_pending')
 *
 * Pure aggregation + rate logic lives in src/winback/lib/stats.ts so
 * it can be unit-tested without mocking drizzle.
 */

const DUNNING_REASON = 'Payment failed'
const ACTIVE_DUNNING_STATES = ['awaiting_retry', 'final_retry_pending'] as const

type Bucket = { recovered: number; mrrRecoveredCents: number }
type Stats = {
  winBack: {
    thisMonth: Bucket
    allTime: Bucket & { recoveryRate: number | null }
    inProgress: number
    // Spec 40
    handoffsNeedingAttention: number
    topReasons: LabelPct[]
  }
  paymentRecovery: {
    thisMonth: Bucket
    allTime: Bucket & { recoveryRate: number | null }
    inDunning: number
    // Spec 40
    mrrAtRiskCents: number
    onFinalAttempt: number
    topDeclineCodes: LabelPct[]
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const monthStart = startOfMonthUtc()

  // Aggregate recoveries — two queries, one for this-month and one for
  // all-time, each grouped by recoveryType only. We previously did this
  // as a single query grouping on (recoveryType, recoveredAt >= monthStart),
  // but Drizzle bound the date parameter twice (once in SELECT, once in
  // GROUP BY) which Postgres rejected as "column must appear in GROUP BY"
  // because the two parameter placeholders were syntactically different
  // even though the runtime value matched. Two queries is simpler than
  // working around that.
  const buildAggRows = async (filterToMonth: boolean): Promise<RecoveryAggRow[]> => {
    const conditions = [eq(recoveries.customerId, customer.id)]
    if (filterToMonth) conditions.push(gte(recoveries.recoveredAt, monthStart))
    const rows = await db
      .select({
        recoveryType: recoveries.recoveryType,
        count: sql<number>`count(*)::int`.as('count'),
        mrrCents: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::bigint`.as('mrr_cents'),
      })
      .from(recoveries)
      .where(and(...conditions))
      .groupBy(recoveries.recoveryType)
    return rows.map((r) => ({
      recoveryType: r.recoveryType,
      isThisMonth: filterToMonth,
      count: Number(r.count),
      mrrCents: Number(r.mrrCents),
    }))
  }

  const [thisMonthAggRows, allTimeAggRows] = await Promise.all([
    buildAggRows(true),
    buildAggRows(false),
  ])
  // allTime rows are tagged isThisMonth=false; the aggregator adds them to
  // the all-time totals only. thisMonth rows tagged isThisMonth=true add to
  // both buckets via the existing reducer logic.
  const aggRows: RecoveryAggRow[] = [...thisMonthAggRows, ...allTimeAggRows]

  const agg = aggregateRecoveryRows(aggRows)
  if (agg.legacyNullCount > 0) {
    console.warn(
      `[stats] ${agg.legacyNullCount} recoveries with NULL recoveryType bucketed as win-back`,
    )
  }

  // Lost counts for recovery-rate denominators. Two separate queries
  // (rather than one with GROUP BY on an expression) — Drizzle binds the
  // 'Payment failed' parameter twice (SELECT alias + GROUP BY) which
  // Postgres rejects as "column must appear in GROUP BY" because the
  // placeholders are syntactically distinct.
  const [{ count: paymentLostRaw }] = await db
    .select({ count: sql<number>`count(*)::int`.as('count') })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.status, 'lost'),
        eq(churnedSubscribers.cancellationReason, DUNNING_REASON),
      ),
    )
  const [{ count: winBackLostRaw }] = await db
    .select({ count: sql<number>`count(*)::int`.as('count') })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.status, 'lost'),
        or(
          ne(churnedSubscribers.cancellationReason, DUNNING_REASON),
          isNull(churnedSubscribers.cancellationReason),
        ),
      ),
    )
  const paymentLost = Number(paymentLostRaw)
  const winBackLost = Number(winBackLostRaw)

  // Current-state counters (no time window).
  const [{ count: inProgress }] = await db
    .select({ count: sql<number>`count(*)::int`.as('count') })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.status, 'contacted'),
        or(
          ne(churnedSubscribers.cancellationReason, DUNNING_REASON),
          isNull(churnedSubscribers.cancellationReason),
        ),
      ),
    )

  const [{ count: inDunning }] = await db
    .select({ count: sql<number>`count(*)::int`.as('count') })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.cancellationReason, DUNNING_REASON),
        sql`${churnedSubscribers.dunningState} in (${sql.raw(
          ACTIVE_DUNNING_STATES.map((s) => `'${s}'`).join(','),
        )})`,
      ),
    )

  // Spec 40 — Win-back: handoffs needing attention (the "Needs you" alert).
  // Filter: handoff opened AND not yet resolved AND not already recovered.
  const [{ count: handoffsNeedingAttention }] = await db
    .select({ count: sql<number>`count(*)::int`.as('count') })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        isNotNull(churnedSubscribers.founderHandoffAt),
        isNull(churnedSubscribers.founderHandoffResolvedAt),
        ne(churnedSubscribers.status, 'recovered'),
        or(
          ne(churnedSubscribers.cancellationReason, DUNNING_REASON),
          isNull(churnedSubscribers.cancellationReason),
        ),
      ),
    )

  // Spec 40 — Win-back: top cancellation categories this month.
  const winBackReasonRows = await db
    .select({
      label: churnedSubscribers.cancellationCategory,
      count: sql<number>`count(*)::int`.as('count'),
    })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        gte(churnedSubscribers.cancelledAt, monthStart),
        or(
          ne(churnedSubscribers.cancellationReason, DUNNING_REASON),
          isNull(churnedSubscribers.cancellationReason),
        ),
      ),
    )
    .groupBy(churnedSubscribers.cancellationCategory)

  const topReasons = topNFromCounts(
    winBackReasonRows.map((r) => ({ label: r.label, count: Number(r.count) })),
    4,
  )

  // Spec 40 — Payment-recovery: MRR at risk + on-final-attempt count.
  const [atRiskRow] = await db
    .select({
      mrrAtRiskCents: sql<number>`coalesce(sum(${churnedSubscribers.mrrCents}), 0)::bigint`.as('mrr_at_risk'),
      onFinalAttempt: sql<number>`count(*) filter (where ${churnedSubscribers.dunningState} = 'final_retry_pending')::int`.as('on_final'),
    })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.cancellationReason, DUNNING_REASON),
        sql`${churnedSubscribers.dunningState} in (${sql.raw(
          ACTIVE_DUNNING_STATES.map((s) => `'${s}'`).join(','),
        )})`,
      ),
    )

  // Spec 40 — Payment-recovery: top decline codes this month.
  // Time anchor is createdAt — payment-recovery rows are inserted by the
  // payment_failed webhook and never have cancelledAt populated (that
  // column is for voluntary-cancel rows). createdAt is the moment we
  // first saw the failure, which is the right "this month" semantics.
  const declineCodeRows = await db
    .select({
      label: churnedSubscribers.lastDeclineCode,
      count: sql<number>`count(*)::int`.as('count'),
    })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.cancellationReason, DUNNING_REASON),
        gte(churnedSubscribers.createdAt, monthStart),
      ),
    )
    .groupBy(churnedSubscribers.lastDeclineCode)

  const topDeclineCodes = topNFromCounts(
    declineCodeRows.map((r) => ({ label: r.label, count: Number(r.count) })),
    4,
  )

  const stats: Stats = {
    winBack: {
      thisMonth: agg.winBackThisMonth,
      allTime: {
        ...agg.winBackAllTime,
        recoveryRate: recoveryRatePct(agg.winBackAllTime.recovered, winBackLost),
      },
      inProgress: Number(inProgress),
      handoffsNeedingAttention: Number(handoffsNeedingAttention),
      topReasons,
    },
    paymentRecovery: {
      thisMonth: agg.paymentThisMonth,
      allTime: {
        ...agg.paymentAllTime,
        recoveryRate: recoveryRatePct(agg.paymentAllTime.recovered, paymentLost),
      },
      inDunning: Number(inDunning),
      mrrAtRiskCents: Number(atRiskRow?.mrrAtRiskCents ?? 0),
      onFinalAttempt: Number(atRiskRow?.onFinalAttempt ?? 0),
      topDeclineCodes,
    },
  }

  return NextResponse.json(stats)
}

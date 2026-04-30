import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm'
import {
  aggregateRecoveryRows,
  recoveryRatePct,
  startOfMonthUtc,
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
  }
  paymentRecovery: {
    thisMonth: Bucket
    allTime: Bucket & { recoveryRate: number | null }
    inDunning: number
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

  // Aggregate recoveries grouped by recoveryType × time-window.
  const recoveryAggRaw = await db
    .select({
      recoveryType: recoveries.recoveryType,
      isThisMonth: sql<boolean>`${recoveries.recoveredAt} >= ${monthStart}`.as('is_this_month'),
      count: sql<number>`count(*)::int`.as('count'),
      mrrCents: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::bigint`.as('mrr_cents'),
    })
    .from(recoveries)
    .where(eq(recoveries.customerId, customer.id))
    .groupBy(recoveries.recoveryType, sql`${recoveries.recoveredAt} >= ${monthStart}`)

  const aggRows: RecoveryAggRow[] = recoveryAggRaw.map((r) => ({
    recoveryType: r.recoveryType,
    isThisMonth: Boolean(r.isThisMonth),
    count: Number(r.count),
    mrrCents: Number(r.mrrCents),
  }))

  const agg = aggregateRecoveryRows(aggRows)
  if (agg.legacyNullCount > 0) {
    console.warn(
      `[stats] ${agg.legacyNullCount} recoveries with NULL recoveryType bucketed as win-back`,
    )
  }

  // Lost counts for recovery-rate denominators. Partition by
  // cancellationReason: 'Payment failed' → payment-recovery-lost,
  // anything else → win-back-lost.
  const lostRows = await db
    .select({
      isPaymentFailed: sql<boolean>`${churnedSubscribers.cancellationReason} = ${DUNNING_REASON}`.as('is_pf'),
      count: sql<number>`count(*)::int`.as('count'),
    })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.status, 'lost'),
      ),
    )
    .groupBy(sql`${churnedSubscribers.cancellationReason} = ${DUNNING_REASON}`)

  let winBackLost = 0
  let paymentLost = 0
  for (const row of lostRows) {
    if (row.isPaymentFailed) paymentLost += Number(row.count)
    else winBackLost += Number(row.count)
  }

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
        sql`${churnedSubscribers.dunningState} in (${sql.raw(
          ACTIVE_DUNNING_STATES.map((s) => `'${s}'`).join(','),
        )})`,
      ),
    )

  const stats: Stats = {
    winBack: {
      thisMonth: agg.winBackThisMonth,
      allTime: {
        ...agg.winBackAllTime,
        recoveryRate: recoveryRatePct(agg.winBackAllTime.recovered, winBackLost),
      },
      inProgress: Number(inProgress),
    },
    paymentRecovery: {
      thisMonth: agg.paymentThisMonth,
      allTime: {
        ...agg.paymentAllTime,
        recoveryRate: recoveryRatePct(agg.paymentAllTime.recovered, paymentLost),
      },
      inDunning: Number(inDunning),
    },
  }

  return NextResponse.json(stats)
}

import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent, recoveries } from '@/lib/schema'
import { and, eq, gte, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import {
  buildDailySeries,
  recoveryRatePct,
  startOfMonthUtc,
  startOfPrevMonthUtc,
  topNFromCounts,
  type LabelPct,
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
type WinBackFilterCounts = {
  all: number
  handoff: number
  'has-reply': number
  paused: number
  recovered: number
  done: number
}
type PaymentFilterCounts = {
  all: number
  'in-retry': number
  'final-retry': number
  recovered: number
  lost: number
}
type Stats = {
  winBack: {
    thisMonth: Bucket
    lastMonth: Bucket                          // Spec 40 polish — month delta
    allTime: Bucket & { recoveryRate: number | null }
    inProgress: number
    handoffsNeedingAttention: number
    topReasons: LabelPct[]
    filterCounts: WinBackFilterCounts          // Spec 40 polish
    dailyRecovered: number[]                   // Spec 40 polish — 30d sparkline
  }
  paymentRecovery: {
    thisMonth: Bucket
    lastMonth: Bucket                          // Spec 40 polish — month delta
    allTime: Bucket & { recoveryRate: number | null }
    inDunning: number
    topDeclineCodes: LabelPct[]
    filterCounts: PaymentFilterCounts          // Spec 40 polish
    dailyRecovered: number[]                   // Spec 40 polish — 30d sparkline
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
  const prevMonthStart = startOfPrevMonthUtc()

  // Aggregate recoveries — three queries (this-month / last-month / all-
  // time), each grouped by recoveryType only. Single combined query was
  // rejected by Postgres because Drizzle bound the date parameter twice
  // (SELECT + GROUP BY) as syntactically distinct placeholders.
  const buildBucketsByType = async (
    range: 'thisMonth' | 'lastMonth' | 'allTime',
  ): Promise<{ winBack: Bucket; payment: Bucket; legacyNullCount: number }> => {
    const conditions = [eq(recoveries.customerId, customer.id)]
    if (range === 'thisMonth') conditions.push(gte(recoveries.recoveredAt, monthStart))
    if (range === 'lastMonth') {
      conditions.push(gte(recoveries.recoveredAt, prevMonthStart))
      conditions.push(lt(recoveries.recoveredAt, monthStart))
    }
    const rows = await db
      .select({
        recoveryType: recoveries.recoveryType,
        count: sql<number>`count(*)::int`.as('count'),
        mrrCents: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::bigint`.as('mrr_cents'),
      })
      .from(recoveries)
      .where(and(...conditions))
      .groupBy(recoveries.recoveryType)
    const out = {
      winBack: { recovered: 0, mrrRecoveredCents: 0 } as Bucket,
      payment: { recovered: 0, mrrRecoveredCents: 0 } as Bucket,
      legacyNullCount: 0,
    }
    for (const r of rows) {
      const count = Number(r.count)
      const mrr = Number(r.mrrCents)
      if (r.recoveryType === 'card_save') {
        out.payment.recovered += count
        out.payment.mrrRecoveredCents += mrr
      } else {
        // 'win_back' or NULL/legacy → bucket as win-back
        if (r.recoveryType === null) out.legacyNullCount += count
        out.winBack.recovered += count
        out.winBack.mrrRecoveredCents += mrr
      }
    }
    return out
  }

  const [thisMonthBuckets, lastMonthBuckets, allTimeBuckets] = await Promise.all([
    buildBucketsByType('thisMonth'),
    buildBucketsByType('lastMonth'),
    buildBucketsByType('allTime'),
  ])
  if (allTimeBuckets.legacyNullCount > 0) {
    console.warn(
      `[stats] ${allTimeBuckets.legacyNullCount} recoveries with NULL recoveryType bucketed as win-back`,
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

  // Spec 40 polish — filter-chip counts. One query per cohort with
  // FILTER clauses; cheap because all counts come from the same scan.
  const winBackBaseWhere = and(
    eq(churnedSubscribers.customerId, customer.id),
    or(
      ne(churnedSubscribers.cancellationReason, DUNNING_REASON),
      isNull(churnedSubscribers.cancellationReason),
    ),
  )
  const [wbCounts] = await db
    .select({
      all: sql<number>`count(*)::int`.as('all'),
      handoff: sql<number>`count(*) filter (where ${churnedSubscribers.founderHandoffAt} is not null and ${churnedSubscribers.founderHandoffResolvedAt} is null)::int`.as('handoff'),
      hasReply: sql<number>`count(*) filter (where exists (
        select 1 from ${emailsSent}
        where ${emailsSent.subscriberId} = ${churnedSubscribers.id}
          and ${emailsSent.repliedAt} is not null
      ))::int`.as('has_reply'),
      paused: sql<number>`count(*) filter (where ${churnedSubscribers.aiPausedUntil} is not null and ${churnedSubscribers.aiPausedUntil} > now())::int`.as('paused'),
      recovered: sql<number>`count(*) filter (where ${churnedSubscribers.status} = 'recovered')::int`.as('recovered'),
      done: sql<number>`count(*) filter (where ${churnedSubscribers.status} in ('lost','skipped') or ${churnedSubscribers.doNotContact} = true)::int`.as('done'),
    })
    .from(churnedSubscribers)
    .where(winBackBaseWhere)

  const paymentBaseWhere = and(
    eq(churnedSubscribers.customerId, customer.id),
    eq(churnedSubscribers.cancellationReason, DUNNING_REASON),
  )
  const [pCounts] = await db
    .select({
      all: sql<number>`count(*)::int`.as('all'),
      inRetry: sql<number>`count(*) filter (where ${churnedSubscribers.dunningState} = 'awaiting_retry')::int`.as('in_retry'),
      finalRetry: sql<number>`count(*) filter (where ${churnedSubscribers.dunningState} = 'final_retry_pending')::int`.as('final_retry'),
      recovered: sql<number>`count(*) filter (where ${churnedSubscribers.status} = 'recovered')::int`.as('recovered'),
      lost: sql<number>`count(*) filter (where ${churnedSubscribers.dunningState} = 'churned_during_dunning' or ${churnedSubscribers.status} = 'lost')::int`.as('lost'),
    })
    .from(churnedSubscribers)
    .where(paymentBaseWhere)

  const winBackFilterCounts: WinBackFilterCounts = {
    all: Number(wbCounts.all),
    handoff: Number(wbCounts.handoff),
    'has-reply': Number(wbCounts.hasReply),
    paused: Number(wbCounts.paused),
    recovered: Number(wbCounts.recovered),
    done: Number(wbCounts.done),
  }
  const paymentFilterCounts: PaymentFilterCounts = {
    all: Number(pCounts.all),
    'in-retry': Number(pCounts.inRetry),
    'final-retry': Number(pCounts.finalRetry),
    recovered: Number(pCounts.recovered),
    lost: Number(pCounts.lost),
  }

  // Spec 40 polish — last 30 days of recoveries, per cohort, for the
  // sparkline. Single query grouped by (recoveryType, day-truncated).
  const sparkStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const dailyRows = await db
    .select({
      recoveryType: recoveries.recoveryType,
      day: sql<string>`to_char(date_trunc('day', ${recoveries.recoveredAt}), 'YYYY-MM-DD')`.as('day'),
      count: sql<number>`count(*)::int`.as('count'),
    })
    .from(recoveries)
    .where(and(eq(recoveries.customerId, customer.id), gte(recoveries.recoveredAt, sparkStart)))
    .groupBy(recoveries.recoveryType, sql`date_trunc('day', ${recoveries.recoveredAt})`)

  const winBackDailyRaw: Array<{ day: string; count: number }> = []
  const paymentDailyRaw: Array<{ day: string; count: number }> = []
  for (const r of dailyRows) {
    const target = r.recoveryType === 'card_save' ? paymentDailyRaw : winBackDailyRaw
    target.push({ day: r.day, count: Number(r.count) })
  }
  const winBackDailyRecovered = buildDailySeries(winBackDailyRaw, 30)
  const paymentDailyRecovered = buildDailySeries(paymentDailyRaw, 30)

  const stats: Stats = {
    winBack: {
      thisMonth: thisMonthBuckets.winBack,
      lastMonth: lastMonthBuckets.winBack,
      allTime: {
        ...allTimeBuckets.winBack,
        recoveryRate: recoveryRatePct(allTimeBuckets.winBack.recovered, winBackLost),
      },
      inProgress: Number(inProgress),
      handoffsNeedingAttention: Number(handoffsNeedingAttention),
      topReasons,
      filterCounts: winBackFilterCounts,
      dailyRecovered: winBackDailyRecovered,
    },
    paymentRecovery: {
      thisMonth: thisMonthBuckets.payment,
      lastMonth: lastMonthBuckets.payment,
      allTime: {
        ...allTimeBuckets.payment,
        recoveryRate: recoveryRatePct(allTimeBuckets.payment.recovered, paymentLost),
      },
      inDunning: Number(inDunning),
      topDeclineCodes,
      filterCounts: paymentFilterCounts,
      dailyRecovered: paymentDailyRecovered,
    },
  }

  return NextResponse.json(stats)
}

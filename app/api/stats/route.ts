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
// Spec 43 — pipeline strip per cohort. churned = recovered + inFlight +
// lost (math always balances; inFlight computed in JS as the residual).
type Pipeline30d = {
  churnedMrrCents: number
  recoveredMrrCents: number
  inFlightMrrCents: number
  lostMrrCents: number
}
type Stats = {
  // Spec 41 — same lifetime number applies to both cohorts (cached on the
  // customer row). Surfaced at the top level so the dashboard reads it once.
  cumulativeRevenueSavedCents: number
  cumulativeRevenueLastComputedAt: string | null
  winBack: {
    thisMonth: Bucket
    lastMonth: Bucket                          // Spec 40 polish — month delta
    allTime: Bucket & { recoveryRate: number | null }
    inProgress: number
    handoffsNeedingAttention: number
    topReasons: LabelPct[]
    filterCounts: WinBackFilterCounts          // Spec 40 polish
    dailyRecovered: number[]                   // Spec 40 polish — 30d sparkline
    pipeline30d: Pipeline30d                   // Spec 43
  }
  paymentRecovery: {
    thisMonth: Bucket
    lastMonth: Bucket                          // Spec 40 polish — month delta
    allTime: Bucket & { recoveryRate: number | null }
    inDunning: number
    topDeclineCodes: LabelPct[]
    filterCounts: PaymentFilterCounts          // Spec 40 polish
    dailyRecovered: number[]                   // Spec 40 polish — 30d sparkline
    pipeline30d: Pipeline30d                   // Spec 43
  }
}

// Spec 43 — Compute the in-flight residual safely. churned − recovered −
// lost can theoretically go negative under data weirdness; clamp to 0
// so we never render a negative dollar amount.
function buildPipeline(
  churned: unknown,
  recovered: unknown,
  lost: unknown,
): Pipeline30d {
  const c = Number(churned)
  const r = Number(recovered)
  const l = Number(lost)
  return {
    churnedMrrCents: c,
    recoveredMrrCents: r,
    lostMrrCents: l,
    inFlightMrrCents: Math.max(0, c - r - l),
  }
}

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [customer] = await db
    .select({
      id: customers.id,
      cumulativeRevenueSavedCents: customers.cumulativeRevenueSavedCents,
      cumulativeRevenueLastComputedAt: customers.cumulativeRevenueLastComputedAt,
    })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const monthStart = startOfMonthUtc()
  const prevMonthStart = startOfPrevMonthUtc()
  // Spec 40 fix — pattern strips use a rolling 30-day window instead of
  // the calendar month. Calendar-month scope was misleading on day 1–3
  // of any month: a 1-row sample would render as "100%" even though the
  // table below shows a clear mix. Rolling window smooths this out and
  // matches what merchants mean by "recent patterns."
  const patternWindowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

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
  // Spec 39 amendment (2026-05-02) — recovery rate is now computed as
  // `recovered_in_30d / cohort_in_30d`, not `recovered / (recovered +
  // lost)`. The cohort denominator + 30d window are computed inside the
  // wbCounts/pCounts queries below (cohort30d / recovered30d filter
  // columns), so no separate "lost" queries are needed.

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

  // Spec 40 — Win-back: top cancellation categories in the last 30 days.
  // `minTotal: 3` hides the strip when sample size would make any
  // percentage misleading (a 1-row sample would otherwise read "100%").
  const winBackReasonRows = await db
    .select({
      label: churnedSubscribers.cancellationCategory,
      count: sql<number>`count(*)::int`.as('count'),
    })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        gte(churnedSubscribers.cancelledAt, patternWindowStart),
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
    { minTotal: 3 },
  )

  // Spec 40 — Payment-recovery: top decline codes in the last 30 days.
  // Time anchor is createdAt — payment-recovery rows are inserted by the
  // payment_failed webhook and never have cancelledAt populated (that
  // column is for voluntary-cancel rows). createdAt is the moment we
  // first saw the failure, which is the right "recent" semantics.
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
        gte(churnedSubscribers.createdAt, patternWindowStart),
      ),
    )
    .groupBy(churnedSubscribers.lastDeclineCode)

  const topDeclineCodes = topNFromCounts(
    declineCodeRows.map((r) => ({ label: r.label, count: Number(r.count) })),
    4,
    { minTotal: 3 },
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
      // Spec 39 amendment — denominator + numerator for the rolling
      // 30-day recovery rate. Anchor on cancelledAt for win-back rows.
      cohort30d: sql<number>`count(*) filter (where ${churnedSubscribers.cancelledAt} >= ${patternWindowStart})::int`.as('cohort_30d'),
      recovered30d: sql<number>`count(*) filter (where ${churnedSubscribers.cancelledAt} >= ${patternWindowStart} and ${churnedSubscribers.status} = 'recovered')::int`.as('recovered_30d'),
      // Spec 43 — pipeline strip MRR sums (last 30 days). In-flight is
      // computed in JS (churned − recovered − lost) so the math always
      // balances. Lost bucket matches Spec 40's "Done" filter chip
      // semantics (skipped + doNotContact roll up under lost from a
      // billing-perspective; Winback won't pursue them further).
      pipelineChurnedMrrCents: sql<number>`coalesce(sum(${churnedSubscribers.mrrCents}) filter (where ${churnedSubscribers.cancelledAt} >= ${patternWindowStart}), 0)::bigint`.as('pipeline_churned_mrr'),
      pipelineRecoveredMrrCents: sql<number>`coalesce(sum(${churnedSubscribers.mrrCents}) filter (where ${churnedSubscribers.cancelledAt} >= ${patternWindowStart} and ${churnedSubscribers.status} = 'recovered'), 0)::bigint`.as('pipeline_recovered_mrr'),
      pipelineLostMrrCents: sql<number>`coalesce(sum(${churnedSubscribers.mrrCents}) filter (where ${churnedSubscribers.cancelledAt} >= ${patternWindowStart} and (${churnedSubscribers.status} in ('lost','skipped') or ${churnedSubscribers.doNotContact} = true)), 0)::bigint`.as('pipeline_lost_mrr'),
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
      // Spec 39 amendment — denominator + numerator for the rolling
      // 30-day recovery rate. Payment-recovery rows don't have
      // cancelledAt populated, so anchor on createdAt (the moment we
      // first saw the failed-payment webhook).
      cohort30d: sql<number>`count(*) filter (where ${churnedSubscribers.createdAt} >= ${patternWindowStart})::int`.as('cohort_30d'),
      recovered30d: sql<number>`count(*) filter (where ${churnedSubscribers.createdAt} >= ${patternWindowStart} and ${churnedSubscribers.status} = 'recovered')::int`.as('recovered_30d'),
      // Spec 43 — pipeline strip MRR sums (last 30 days). Lost bucket
      // matches Spec 40's payment-recovery filter chip semantics.
      pipelineChurnedMrrCents: sql<number>`coalesce(sum(${churnedSubscribers.mrrCents}) filter (where ${churnedSubscribers.createdAt} >= ${patternWindowStart}), 0)::bigint`.as('pipeline_churned_mrr'),
      pipelineRecoveredMrrCents: sql<number>`coalesce(sum(${churnedSubscribers.mrrCents}) filter (where ${churnedSubscribers.createdAt} >= ${patternWindowStart} and ${churnedSubscribers.status} = 'recovered'), 0)::bigint`.as('pipeline_recovered_mrr'),
      pipelineLostMrrCents: sql<number>`coalesce(sum(${churnedSubscribers.mrrCents}) filter (where ${churnedSubscribers.createdAt} >= ${patternWindowStart} and (${churnedSubscribers.dunningState} = 'churned_during_dunning' or ${churnedSubscribers.status} = 'lost')), 0)::bigint`.as('pipeline_lost_mrr'),
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
    // Spec 41 — cached lifetime revenue saved (cron-populated, ≤24h stale).
    cumulativeRevenueSavedCents: Number(customer.cumulativeRevenueSavedCents),
    cumulativeRevenueLastComputedAt:
      customer.cumulativeRevenueLastComputedAt?.toISOString() ?? null,
    winBack: {
      thisMonth: thisMonthBuckets.winBack,
      lastMonth: lastMonthBuckets.winBack,
      allTime: {
        ...allTimeBuckets.winBack,
        recoveryRate: recoveryRatePct(
          Number(wbCounts.recovered30d),
          Number(wbCounts.cohort30d),
        ),
      },
      inProgress: Number(inProgress),
      handoffsNeedingAttention: Number(handoffsNeedingAttention),
      topReasons,
      filterCounts: winBackFilterCounts,
      dailyRecovered: winBackDailyRecovered,
      pipeline30d: buildPipeline(
        wbCounts.pipelineChurnedMrrCents,
        wbCounts.pipelineRecoveredMrrCents,
        wbCounts.pipelineLostMrrCents,
      ),
    },
    paymentRecovery: {
      thisMonth: thisMonthBuckets.payment,
      lastMonth: lastMonthBuckets.payment,
      allTime: {
        ...allTimeBuckets.payment,
        recoveryRate: recoveryRatePct(
          Number(pCounts.recovered30d),
          Number(pCounts.cohort30d),
        ),
      },
      inDunning: Number(inDunning),
      topDeclineCodes,
      filterCounts: paymentFilterCounts,
      dailyRecovered: paymentDailyRecovered,
      pipeline30d: buildPipeline(
        pCounts.pipelineChurnedMrrCents,
        pCounts.pipelineRecoveredMrrCents,
        pCounts.pipelineLostMrrCents,
      ),
    },
  }

  return NextResponse.json(stats)
}

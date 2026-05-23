import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent, recoveries, subscriberReplies } from '@/lib/schema'
import { eq, and, or, ilike, desc, isNull, ne, sql, count, inArray, isNotNull, getTableColumns } from 'drizzle-orm'
import { aiStateFilterCondition, isValidAiStateFilter, awaitingReplyExpr } from '@/lib/ai-state'

const DUNNING_REASON = 'Payment failed'

// Spec 73 — offset pagination defaults + clamps.
const DEFAULT_PAGE_SIZE = 25
const MAX_PAGE_SIZE     = 100
const MIN_PAGE_SIZE     = 1

function parsePagination(searchParams: URLSearchParams): { page: number; pageSize: number } {
  const rawPage     = Number.parseInt(searchParams.get('page')     ?? '1',  10)
  const rawPageSize = Number.parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10)
  const page     = Number.isFinite(rawPage)     && rawPage     >= 1 ? rawPage     : 1
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1
    ? Math.min(Math.max(rawPageSize, MIN_PAGE_SIZE), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE
  return { page, pageSize }
}

export async function GET(req: NextRequest) {
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

  const { searchParams } = req.nextUrl
  const filter = searchParams.get('filter') ?? 'all'
  const search = searchParams.get('search') ?? ''
  // Spec 40 — cohort partitioning. Backwards-compatible: omitted ⇒ all rows.
  const cohort = searchParams.get('cohort')
  const hasReply = searchParams.get('hasReply') === 'true'

  // Spec 73 — pagination params.
  const { page, pageSize } = parsePagination(searchParams)

  const conditions = [eq(churnedSubscribers.customerId, customer.id)]

  // Spec 40 — cohort partitioning by cancellationReason.
  if (cohort === 'winback') {
    conditions.push(
      or(
        ne(churnedSubscribers.cancellationReason, DUNNING_REASON),
        isNull(churnedSubscribers.cancellationReason),
      )!,
    )
  } else if (cohort === 'payment-recovery') {
    conditions.push(eq(churnedSubscribers.cancellationReason, DUNNING_REASON))
  }

  // Spec 22b — AI-state filters (active, handoff, paused, etc.) for the
  //   win-back cohort.
  // Spec 40 — payment-recovery cohort uses dunning-state filters.
  // Legacy status values (pending, contacted) are still supported as a fallback.
  if (filter !== 'all') {
    if (cohort === 'payment-recovery') {
      if (filter === 'in-retry') {
        conditions.push(eq(churnedSubscribers.dunningState, 'awaiting_retry'))
      } else if (filter === 'final-retry') {
        conditions.push(eq(churnedSubscribers.dunningState, 'final_retry_pending'))
      } else if (filter === 'recovered') {
        conditions.push(eq(churnedSubscribers.status, 'recovered'))
      } else if (filter === 'lost') {
        conditions.push(
          or(
            eq(churnedSubscribers.dunningState, 'churned_during_dunning'),
            eq(churnedSubscribers.status, 'lost'),
          )!,
        )
      }
    } else if (filter === 'awaiting') {
      // Drawer redesign — "the ball's in your court": subscriber replied
      // more recently than the founder did, and the row is still open.
      conditions.push(awaitingReplyExpr())
    } else if (filter === 'high') {
      conditions.push(
        and(
          eq(churnedSubscribers.recoveryLikelihood, 'high'),
          sql`${churnedSubscribers.status} not in ('recovered', 'lost', 'skipped')`,
        )!,
      )
    } else if (isValidAiStateFilter(filter)) {
      const cond = aiStateFilterCondition(filter)
      if (cond) conditions.push(cond)
    } else {
      conditions.push(eq(churnedSubscribers.status, filter))
    }
  }

  // Spec 40 — "Has reply" filter: subscribers with at least one replied email.
  if (hasReply) {
    conditions.push(
      sql`exists (
        select 1 from ${emailsSent}
        where ${emailsSent.subscriberId} = ${churnedSubscribers.id}
          and ${emailsSent.repliedAt} is not null
      )`,
    )
  }

  if (search) {
    const searchPattern = `%${search}%`
    conditions.push(
      or(
        ilike(churnedSubscribers.name, searchPattern),
        ilike(churnedSubscribers.email, searchPattern),
        ilike(churnedSubscribers.cancellationReason, searchPattern),
      )!,
    )
  }

  // Spec 40 — sort policy:
  //   payment-recovery cohort: most-urgent retry first (next_payment_attempt ASC NULLS LAST)
  //   winback cohort, filter='all': awaiting-you → high recovery → recency
  //   anything else: cancelledAt DESC (legacy)
  const orderBy =
    cohort === 'payment-recovery'
      ? [
          sql`${churnedSubscribers.nextPaymentAttemptAt} asc nulls last`,
          desc(churnedSubscribers.cancelledAt),
        ]
      : cohort === 'winback' && filter === 'all'
        ? [
            // Drawer redesign — "All" view priority, matching the dashboard
            // model (the founder skims and acts):
            //   1. Awaiting your reply — the ball is in your court, top.
            //   2. High recovery likelihood — worth a personal look.
            //   3. Everything else, most recent cancellation first.
            sql`case
              when ${awaitingReplyExpr()} then 0
              when ${churnedSubscribers.recoveryLikelihood} = 'high' then 1
              else 2 end`,
            desc(churnedSubscribers.cancelledAt),
          ]
        : [desc(churnedSubscribers.cancelledAt)]

  // Spec 73 — paginated SELECT + COUNT under the same WHERE conditions
  // so `total` and `rows` agree. Two queries per request; the COUNT is
  // cheap on indexed columns and the SELECT is bounded by pageSize.
  const where = and(...conditions)
  const [rows, [totalRow]] = await Promise.all([
    db.select({
      ...getTableColumns(churnedSubscribers),
      // Drawer redesign — surface the latest inbound reply inline so the
      // list can show the subscriber's own words on "awaiting" rows, and
      // a flag so the row can be visually marked as needing a reply. Both
      // are correlated subqueries on the same scan — no extra round-trip.
      // Outer id MUST be qualified — see awaitingReplyExpr() for why a bare
      // ${churnedSubscribers.id} silently binds to sr.id here.
      latestReplySnippet: sql<string | null>`(
        select sr.body from ${subscriberReplies} sr
        where sr.subscriber_id = ${churnedSubscribers}."id"
        order by sr.received_at desc
        limit 1
      )`.as('latest_reply_snippet'),
      awaitingReply: awaitingReplyExpr().as('awaiting_reply'),
    })
      .from(churnedSubscribers)
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() })
      .from(churnedSubscribers)
      .where(where),
  ])

  // Billing-rewrite: applied-promotion chip removed alongside the
  // perf-fee promo path. The applied_promotion_code_id column on
  // wb_recoveries was dropped. If we add platform-side or merchant-side
  // promo display later, build a fresh lookup — don't resurrect the join.
  const rowsWithPromo = rows.map((r) => ({
    ...r,
    appliedPromotionChip: null as string | null,
  }))

  return NextResponse.json({
    rows: rowsWithPromo,
    total: Number(totalRow?.n ?? 0),
    page,
    pageSize,
  })
}

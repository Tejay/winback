import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent } from '@/lib/schema'
import { eq, and, or, ilike, desc, isNull, ne, sql, count } from 'drizzle-orm'
import { aiStateFilterCondition, isValidAiStateFilter } from '@/lib/ai-state'

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
  //   winback cohort, filter='all': handoffs → replies → recency
  //   anything else: cancelledAt DESC (legacy)
  const orderBy =
    cohort === 'payment-recovery'
      ? [
          sql`${churnedSubscribers.nextPaymentAttemptAt} asc nulls last`,
          desc(churnedSubscribers.cancelledAt),
        ]
      : cohort === 'winback' && filter === 'all'
        ? [
            sql`case
              when ${churnedSubscribers.founderHandoffAt} is not null
                and ${churnedSubscribers.founderHandoffResolvedAt} is null
              then 0 else 1 end`,
            sql`case when exists (
              select 1 from ${emailsSent}
              where ${emailsSent.subscriberId} = ${churnedSubscribers.id}
                and ${emailsSent.repliedAt} is not null
            ) then 0 else 1 end`,
            desc(churnedSubscribers.cancelledAt),
          ]
        : [desc(churnedSubscribers.cancelledAt)]

  // Spec 73 — paginated SELECT + COUNT under the same WHERE conditions
  // so `total` and `rows` agree. Two queries per request; the COUNT is
  // cheap on indexed columns and the SELECT is bounded by pageSize.
  const where = and(...conditions)
  const [rows, [totalRow]] = await Promise.all([
    db.select()
      .from(churnedSubscribers)
      .where(where)
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: count() })
      .from(churnedSubscribers)
      .where(where),
  ])

  return NextResponse.json({
    rows,
    total: Number(totalRow?.n ?? 0),
    page,
    pageSize,
  })
}

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent } from '@/lib/schema'
import { eq, and, or, ilike, desc, isNull, ne, sql } from 'drizzle-orm'
import { aiStateFilterCondition, isValidAiStateFilter } from '@/lib/ai-state'

const DUNNING_REASON = 'Payment failed'

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

  const subs = await db
    .select()
    .from(churnedSubscribers)
    .where(and(...conditions))
    .orderBy(...orderBy)

  return NextResponse.json(subs)
}

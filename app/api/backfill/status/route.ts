import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and, sql } from 'drizzle-orm'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [customer] = await db
    .select({
      id: customers.id,
      backfillTotal: customers.backfillTotal,
      backfillProcessed: customers.backfillProcessed,
      backfillStartedAt: customers.backfillStartedAt,
      backfillCompletedAt: customers.backfillCompletedAt,
    })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  // Get summary stats for completed backfill
  let lostMrrCents = 0
  let contacted = 0
  let skipped = 0

  if (customer.backfillCompletedAt) {
    const [stats] = await db
      .select({
        totalMrr: sql<number>`COALESCE(SUM(mrr_cents), 0)`,
        contactedCount: sql<number>`COUNT(*) FILTER (WHERE status = 'contacted')`,
        skippedCount: sql<number>`COUNT(*) FILTER (WHERE status = 'skipped')`,
      })
      .from(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.customerId, customer.id),
          eq(churnedSubscribers.source, 'backfill')
        )
      )

    lostMrrCents = Number(stats?.totalMrr ?? 0)
    contacted = Number(stats?.contactedCount ?? 0)
    skipped = Number(stats?.skippedCount ?? 0)
  }

  return NextResponse.json({
    total: customer.backfillTotal ?? 0,
    processed: customer.backfillProcessed ?? 0,
    complete: !!customer.backfillCompletedAt,
    startedAt: customer.backfillStartedAt?.toISOString() ?? null,
    completedAt: customer.backfillCompletedAt?.toISOString() ?? null,
    lostMrrCents,
    contacted,
    skipped,
  })
}

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { customers, users, churnedSubscribers, recoveries, wbEvents } from '@/lib/schema'
import { and, eq, ilike, isNull, or, sql, desc } from 'drizzle-orm'

/**
 * GET /api/admin/customers?q=...&filter=...&limit=50
 *
 * Cross-customer list for /admin/customers. Search matches founder email,
 * founder name, product name, or Stripe account id (ILIKE). Filter values:
 *   - `stuck_on_signup` (Spec 30): customers who registered but never
 *     connected Stripe — `stripe_account_id IS NULL`.
 * Returns counts and last-activity timestamp per row.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { searchParams } = req.nextUrl
  const q = (searchParams.get('q') ?? '').trim()
  const filter = searchParams.get('filter') ?? ''
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 200)

  const filters = []
  if (q) {
    const pat = `%${q}%`
    const cond = or(
      ilike(users.email, pat),
      ilike(customers.founderName, pat),
      ilike(customers.productName, pat),
      ilike(customers.stripeAccountId, pat),
    )
    if (cond) filters.push(cond)
  }
  // Spec 30 — "Stuck on signup" filter (registered but never connected Stripe).
  if (filter === 'stuck_on_signup') {
    filters.push(isNull(customers.stripeAccountId))
  }

  const rows = await getDbReadOnly()
    .select({
      id: customers.id,
      email: users.email,
      founderName: customers.founderName,
      productName: customers.productName,
      plan: customers.plan,
      stripeConnected: sql<boolean>`${customers.stripeAccessToken} is not null`,
      stripeAccountId: customers.stripeAccountId,
      pausedAt: customers.pausedAt,
      subsCount: sql<number>`(
        select count(*)::int from ${churnedSubscribers}
        where ${churnedSubscribers.customerId} = ${customers.id}
      )`,
      recoveriesCount: sql<number>`(
        select count(*)::int from ${recoveries}
        where ${recoveries.customerId} = ${customers.id}
      )`,
      lastEventAt: sql<Date | null>`(
        select max(${wbEvents.createdAt}) from ${wbEvents}
        where ${wbEvents.customerId} = ${customers.id}
      )`,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(customers.createdAt))
    .limit(limit)

  return NextResponse.json({ rows, total: rows.length })
}

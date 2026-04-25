import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { wbEvents, customers, users } from '@/lib/schema'
import { eq, and, sql, desc } from 'drizzle-orm'

/**
 * GET /api/admin/events
 *   ?name=...           filter by event name (one of the 24 known names)
 *   &customerId=uuid    filter to a single customer
 *   &since=1h|24h|7d|30d
 *   &q=...              ILIKE on properties::text (slow on big tables)
 *   &limit=200          default 200, max 500
 *
 * Always returns rows ordered by created_at desc. Always uses the read-only
 * connection; the (name, created_at) and (customer_id, created_at) indexes
 * cover the dominant query patterns.
 */

const SINCE_INTERVALS: Record<string, string> = {
  '1h': '1 hour',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { searchParams } = req.nextUrl
  const name = searchParams.get('name')?.trim() || null
  const customerId = searchParams.get('customerId')?.trim() || null
  const since = searchParams.get('since')?.trim() || '24h'
  const q = searchParams.get('q')?.trim() || null
  const limit = Math.min(Number(searchParams.get('limit')) || 200, 500)

  const interval = SINCE_INTERVALS[since] ?? SINCE_INTERVALS['24h']

  const filters = [sql`${wbEvents.createdAt} > now() - interval '${sql.raw(interval)}'`]
  if (name) filters.push(eq(wbEvents.name, name))
  if (customerId) filters.push(eq(wbEvents.customerId, customerId))
  if (q) filters.push(sql`${wbEvents.properties}::text ILIKE ${'%' + q + '%'}`)

  const rows = await getDbReadOnly()
    .select({
      id: wbEvents.id,
      name: wbEvents.name,
      customerId: wbEvents.customerId,
      customerEmail: users.email,
      properties: wbEvents.properties,
      createdAt: wbEvents.createdAt,
    })
    .from(wbEvents)
    .leftJoin(customers, eq(wbEvents.customerId, customers.id))
    .leftJoin(users, eq(customers.userId, users.id))
    .where(and(...filters))
    .orderBy(desc(wbEvents.createdAt))
    .limit(limit)

  return NextResponse.json({ rows, total: rows.length })
}

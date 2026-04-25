import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { wbEvents, customers, users } from '@/lib/schema'
import { eq, and, sql, desc } from 'drizzle-orm'

/**
 * GET /api/admin/events
 *   ?name=...           filter by event name (one of the 24 known names)
 *   &customer=...       filter to a single customer — accepts either a UUID
 *                       or an email (resolved via wb_users.email join). The
 *                       legacy `customerId` param is also accepted for back-
 *                       compat with old links/bookmarks.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { searchParams } = req.nextUrl
  const name = searchParams.get('name')?.trim() || null
  // Accept either ?customer (new — email or UUID) or ?customerId (legacy — UUID only).
  // ?customer wins when both are present.
  const customerInput = (searchParams.get('customer') ?? searchParams.get('customerId') ?? '').trim() || null
  const since = searchParams.get('since')?.trim() || '24h'
  const q = searchParams.get('q')?.trim() || null
  const limit = Math.min(Number(searchParams.get('limit')) || 200, 500)

  // Resolve the customer input to a UUID. If it's already UUID-shaped, use
  // directly. Otherwise treat as email and look up via the unique users.email
  // constraint. If the email isn't on file, return an empty result with a
  // flag so the UI can show "no customer with that email" rather than
  // misleading "no events".
  let customerId: string | null = null
  if (customerInput) {
    if (UUID_RE.test(customerInput)) {
      customerId = customerInput
    } else {
      const [row] = await getDbReadOnly()
        .select({ id: customers.id })
        .from(customers)
        .innerJoin(users, eq(customers.userId, users.id))
        .where(sql`lower(${users.email}) = ${customerInput.toLowerCase()}`)
        .limit(1)
      if (!row) {
        return NextResponse.json({
          rows: [],
          total: 0,
          customerNotFound: true,
          customerInput,
        })
      }
      customerId = row.id
    }
  }

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

  // Spec 26 — when a customer is filtered and the date window returns zero,
  // tell the UI whether the customer has events outside the chosen range.
  // Avoids the silent-zero failure mode ("looks broken" when really it's
  // just "no recent activity").
  if (customerId && rows.length === 0) {
    const [outside] = await getDbReadOnly()
      .select({ n: sql<number>`count(*)::int` })
      .from(wbEvents)
      .where(eq(wbEvents.customerId, customerId))
    const outsideCount = outside?.n ?? 0
    if (outsideCount > 0) {
      return NextResponse.json({
        rows: [],
        total: 0,
        customerEventsOutsideRange: outsideCount,
      })
    }
  }

  return NextResponse.json({ rows, total: rows.length })
}

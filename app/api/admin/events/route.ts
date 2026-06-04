import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { wbEvents, customers, users } from '@/lib/schema'
import { eq, and, inArray, sql, desc } from 'drizzle-orm'

/**
 * GET /api/admin/events
 *   ?name=...           filter by a single event name
 *   &kind=errors|admin|lifecycle|cron   coarse quick-filter (a set of names)
 *   &customer=...       UUID or email (resolved via wb_users.email)
 *   &since=1h|24h|7d|30d
 *   &q=...              ILIKE on properties::text (slow on big tables)
 *   &limit=200          default 200, max 500
 *
 * Events is the universal drill-down target for the admin (every
 * "investigate →" lands here), so it returns enough to triage on landing:
 * rows + `eventNames` (each tagged active/legacy by last-seen recency, so
 * the dropdown can hide event types the software no longer emits without
 * deleting any history).
 */

const SINCE_INTERVALS: Record<string, string> = {
  '1h': '1 hour',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An event name is "active" if it's been emitted within this window. Older
 *  = legacy. */
const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Event names the software removed and no longer emits anywhere in live
 * code (verified by grep). Always grouped under "Legacy" regardless of
 * recency — seed/historical rows can otherwise make a dead event look
 * active. Add to this when an event name is retired from the codebase.
 */
const KNOWN_LEGACY_NAMES = new Set([
  'subscriber_auto_lost',        // no auto-lost decision anymore
  'founder_handoff_triggered',   // "there is no automatic handoff anymore"
  'proactive_nudge_sent',        // retired
])

/** Subscriber-journey events for the `lifecycle` quick-filter. */
const LIFECYCLE_NAMES = [
  'subscriber_classified',
  'subscriber_recovered',
  'subscriber_unsubscribed',
  'email_sent',
  'email_replied',
  'reengagement_email_sent',
  'classify_dead_lettered',
]

function kindCondition(kind: string) {
  switch (kind) {
    case 'errors':
      return sql`(${wbEvents.name} LIKE '%failed' OR ${wbEvents.name} LIKE '%error' OR ${wbEvents.name} = 'webhook_signature_invalid')`
    case 'admin':
      return sql`${wbEvents.name} LIKE 'admin\\_%'`
    case 'cron':
      return eq(wbEvents.name, 'cron_run')
    case 'lifecycle':
      return inArray(wbEvents.name, LIFECYCLE_NAMES)
    default:
      return null
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { searchParams } = req.nextUrl
  const name = searchParams.get('name')?.trim() || null
  const kind = searchParams.get('kind')?.trim() || null
  const customerInput = (searchParams.get('customer') ?? searchParams.get('customerId') ?? '').trim() || null
  const since = searchParams.get('since')?.trim() || '24h'
  const q = searchParams.get('q')?.trim() || null
  const limit = Math.min(Number(searchParams.get('limit')) || 200, 500)

  // Event-name registry with active/legacy tagging. group-by name + max
  // created_at; names not seen in ACTIVE_WINDOW are legacy (still selectable,
  // just grouped separately so dead event types don't clutter the list).
  const nameRows = await getDbReadOnly()
    .select({ name: wbEvents.name, lastSeen: sql<string>`max(${wbEvents.createdAt})` })
    .from(wbEvents)
    .groupBy(wbEvents.name)
    .orderBy(wbEvents.name)
  const activeCutoff = Date.now() - ACTIVE_WINDOW_MS
  const eventNames = nameRows.map((r) => ({
    name: r.name,
    // Legacy if explicitly retired OR not emitted within the active window.
    active: !KNOWN_LEGACY_NAMES.has(r.name)
      && !!r.lastSeen && new Date(r.lastSeen).getTime() >= activeCutoff,
  }))

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
        return NextResponse.json({ rows: [], total: 0, customerNotFound: true, customerInput, eventNames })
      }
      customerId = row.id
    }
  }

  const interval = SINCE_INTERVALS[since] ?? SINCE_INTERVALS['24h']

  const filters = [sql`${wbEvents.createdAt} > now() - interval '${sql.raw(interval)}'`]
  if (name) filters.push(eq(wbEvents.name, name))
  if (kind) {
    const cond = kindCondition(kind)
    if (cond) filters.push(cond)
  }
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

  if (customerId && rows.length === 0) {
    const [outside] = await getDbReadOnly()
      .select({ n: sql<number>`count(*)::int` })
      .from(wbEvents)
      .where(eq(wbEvents.customerId, customerId))
    const outsideCount = outside?.n ?? 0
    if (outsideCount > 0) {
      return NextResponse.json({ rows: [], total: 0, customerEventsOutsideRange: outsideCount, eventNames })
    }
  }

  return NextResponse.json({ rows, total: rows.length, eventNames })
}

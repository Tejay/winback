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

/**
 * Event names the software removed and no longer emits anywhere in live
 * code — verified by checking for a live emit site per name. "Legacy" is
 * this explicit list ONLY: a recency heuristic (e.g. "not seen in 30d")
 * is unreliable because a genuinely-live but rarely-fired event like
 * oauth_error would be mislabelled. The code is the source of truth for
 * what's emitted, not data recency.
 *
 * Grouped by the feature that was removed. Add a name here when you
 * retire an event from the codebase.
 */
const KNOWN_LEGACY_NAMES = new Set([
  // Founder-handoff era — "there is no automatic handoff anymore"
  'founder_handoff_triggered',
  'founder_handed_back',
  'founder_took_over',
  // Auto-lost decision — removed
  'subscriber_auto_lost',
  'proactive_nudge_sent',
  // Performance-fee era — removed in the billing rewrite
  'performance_fee_skipped_flat_rate',
  'win_back_perf_fee_fired',
  'win_back_refunded',
  // Misc retired
  'billing_cron_complete',
  'pilot_account_deleted_manual',
  'promotions_enabled_changed',
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

  // Event-name registry. Every distinct name ever emitted, each tagged
  // active vs. legacy (retired from the codebase) so dead event types
  // group separately instead of cluttering the list. Nothing is deleted.
  const nameRows = await getDbReadOnly()
    .selectDistinct({ name: wbEvents.name })
    .from(wbEvents)
    .orderBy(wbEvents.name)
  const eventNames = nameRows.map((r) => ({
    name: r.name,
    // Legacy = explicitly retired (see KNOWN_LEGACY_NAMES). Everything else
    // is active, including rarely-fired live events like oauth_error.
    active: !KNOWN_LEGACY_NAMES.has(r.name),
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

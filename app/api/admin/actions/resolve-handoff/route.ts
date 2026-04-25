import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { churnedSubscribers } from '@/lib/schema'
import { eq, and, isNotNull, isNull, sql } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/admin/actions/resolve-handoff
 * Body: { customerId: string }
 *
 * Bulk-resolves every open handoff for a given customer (sets
 * founder_handoff_resolved_at = now). Useful when a founder reports
 * "I've handled all of these in my own inbox already, clear the dashboard".
 */
export async function POST(req: Request) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const body = await req.json().catch(() => ({}))
  const customerId = String(body.customerId ?? '').trim()
  if (!customerId) {
    return NextResponse.json({ error: 'customerId required' }, { status: 400 })
  }

  const result = await db
    .update(churnedSubscribers)
    .set({
      founderHandoffResolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(churnedSubscribers.customerId, customerId),
        isNotNull(churnedSubscribers.founderHandoffAt),
        isNull(churnedSubscribers.founderHandoffResolvedAt),
      ),
    )
    .returning({ id: churnedSubscribers.id })

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    customerId,
    properties: { action: 'resolve_open_handoffs', resolvedCount: result.length },
  })

  return NextResponse.json({ ok: true, resolvedCount: result.length })
}

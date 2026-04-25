import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { churnedSubscribers } from '@/lib/schema'
import { inArray } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/admin/actions/bulk-unsubscribe
 * Body: { subscriberIds: string[] }
 *
 * Sets do_not_contact = true on every subscriber in the list. One DB UPDATE,
 * one admin_action event with the batch, idempotent. The send pipeline
 * already consults doNotContact in scheduleExitEmail / sendReplyEmail / sendEmail.
 *
 * Capped at 100 ids per request to keep the audit-event payload bounded.
 */
const MAX_BATCH = 100

export async function POST(req: Request) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const body = await req.json().catch(() => ({}))
  const ids = Array.isArray(body.subscriberIds)
    ? body.subscriberIds.map((x: unknown) => String(x)).filter(Boolean)
    : []

  if (ids.length === 0) {
    return NextResponse.json({ error: 'subscriberIds required (non-empty array)' }, { status: 400 })
  }
  if (ids.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `bulk batch too large (max ${MAX_BATCH})` }, { status: 400 },
    )
  }

  const updated = await db
    .update(churnedSubscribers)
    .set({
      doNotContact: true,
      unsubscribedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(inArray(churnedSubscribers.id, ids))
    .returning({ id: churnedSubscribers.id })

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    properties: {
      action: 'bulk_unsubscribe',
      requestedCount: ids.length,
      updatedCount: updated.length,
      subscriberIds: ids,
    },
  })

  return NextResponse.json({ ok: true, count: updated.length })
}

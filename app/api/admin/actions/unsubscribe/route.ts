import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/admin/actions/unsubscribe
 * Body: { subscriberId: string }
 *
 * Sets do_not_contact = true on a single subscriber. Idempotent. Used by
 * the cross-customer subscriber-search row action when a subscriber
 * complains "stop emailing me". Production send pipeline already consults
 * doNotContact in scheduleExitEmail / sendReplyEmail / sendEmail.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const body = await req.json().catch(() => ({}))
  const subscriberId = String(body.subscriberId ?? '').trim()
  if (!subscriberId) {
    return NextResponse.json({ error: 'subscriberId required' }, { status: 400 })
  }

  await db
    .update(churnedSubscribers)
    .set({
      doNotContact: true,
      unsubscribedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    properties: { action: 'unsubscribe_subscriber', subscriberId },
  })

  return NextResponse.json({ ok: true })
}

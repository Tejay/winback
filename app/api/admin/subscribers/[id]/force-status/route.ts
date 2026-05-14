import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 70 #3 — admin "Force status" action.
 *
 * POST { status, note }
 *   status ∈ {'pending', 'contacted', 'recovered', 'lost'}
 *   note: free-text reason, required, ≥ 5 chars
 *
 * Overrides the auto-attributed status field on wb_churned_subscribers.
 * Common use cases:
 *   - Revive an auto-expired (status='lost') subscriber who emailed the
 *     merchant out of the blue.
 *   - Flip a 'recovered' attribution to 'lost' when the merchant says
 *     "they came back because of my own retention email, not yours"
 *     (refund flow handles billing separately — see Spec 67).
 *
 * Does NOT trigger billing. The perf-fee charge path is webhook-driven
 * by subscription events; manual status overrides intentionally skip it.
 */
const ALLOWED_STATUSES = ['pending', 'contacted', 'recovered', 'lost'] as const
type AllowedStatus = typeof ALLOWED_STATUSES[number]

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const status = String(body.status ?? '') as AllowedStatus
  const note = String(body.note ?? '').trim()

  if (!ALLOWED_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of ${ALLOWED_STATUSES.join(', ')}` },
      { status: 400 },
    )
  }
  if (note.length < 5) {
    return NextResponse.json(
      { error: 'note is required and must be at least 5 characters' },
      { status: 400 },
    )
  }

  const [existing] = await db
    .select({ status: churnedSubscribers.status, customerId: churnedSubscribers.customerId })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, id))
    .limit(1)

  if (!existing) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  if (existing.status === status) {
    return NextResponse.json(
      { error: `Status is already '${status}'; no change` },
      { status: 400 },
    )
  }

  await db
    .update(churnedSubscribers)
    .set({ status, updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, id))

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    customerId: existing.customerId,
    properties: {
      action: 'subscriber_force_status',
      subscriberId: id,
      oldStatus: existing.status,
      newStatus: status,
      note,
    },
  })

  return NextResponse.json({ ok: true, oldStatus: existing.status, newStatus: status })
}

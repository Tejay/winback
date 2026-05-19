import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/subscribers/[id]/hand-back
 *
 * Founder hands a manually-controlled conversation back to AI. Inverse
 * of /api/subscribers/[id]/take-over. Clears all ai_paused_* fields so
 * the AI follow-up path resumes on the next inbound reply.
 *
 * Auth: session + ownership check.
 */

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: subscriberId } = await params

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const [sub] = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.id, subscriberId),
        eq(churnedSubscribers.customerId, customer.id),
      ),
    )
    .limit(1)
  if (!sub) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  await db
    .update(churnedSubscribers)
    .set({
      aiPausedUntil:  null,
      aiPausedAt:     null,
      aiPausedReason: null,
      updatedAt:      new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'founder_handed_back',
    customerId: customer.id,
    properties: { subscriberId },
  })

  return NextResponse.json({ ok: true })
}

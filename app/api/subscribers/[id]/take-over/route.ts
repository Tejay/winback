import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/subscribers/[id]/take-over
 *
 * Founder takes manual control of an AI-handled conversation. AI is
 * paused for this subscriber until the founder explicitly hands it back
 * (via /api/subscribers/[id]/hand-back).
 *
 * Implementation: writes the new state into the existing
 * ai_paused_until / ai_paused_reason columns (Spec 22a). aiPausedUntil
 * is set to a far-future sentinel — pause is indefinite by design, the
 * founder owns the conversation until they release it.
 *
 * Auth: session + ownership check.
 */

const INDEFINITE_PAUSE = new Date('9999-12-31T00:00:00Z')

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
      aiPausedUntil:  INDEFINITE_PAUSE,
      aiPausedAt:     new Date(),
      aiPausedReason: 'takeover',
      updatedAt:      new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'founder_took_over',
    customerId: customer.id,
    properties: { subscriberId },
  })

  return NextResponse.json({ ok: true })
}

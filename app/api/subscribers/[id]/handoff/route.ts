import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 21c — POST /api/subscribers/[id]/handoff
 * Body: { action: 'snooze' | 'resolve', durationDays?: number }
 *
 * - snooze: sets founderHandoffSnoozedUntil to now + durationDays
 * - resolve: sets founderHandoffResolvedAt to now
 *
 * Auth: standard session check; subscriber must belong to the caller's customer.
 */

const schema = z.union([
  z.object({
    action: z.literal('snooze'),
    durationDays: z.number().int().min(1).max(60),
  }),
  z.object({
    action: z.literal('resolve'),
  }),
])

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: subscriberId } = await params
  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  // Look up customer for this user
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  // Verify the subscriber belongs to this customer
  const [sub] = await db
    .select({
      id: churnedSubscribers.id,
      founderHandoffAt: churnedSubscribers.founderHandoffAt,
    })
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

  if (parsed.data.action === 'snooze') {
    const snoozedUntil = new Date(Date.now() + parsed.data.durationDays * 24 * 60 * 60 * 1000)
    await db
      .update(churnedSubscribers)
      .set({ founderHandoffSnoozedUntil: snoozedUntil, updatedAt: new Date() })
      .where(eq(churnedSubscribers.id, subscriberId))

    logEvent({
      name: 'handoff_snoozed',
      customerId: customer.id,
      properties: { subscriberId, durationDays: parsed.data.durationDays },
    })

    return NextResponse.json({ ok: true, snoozedUntil })
  }

  // resolve
  await db
    .update(churnedSubscribers)
    .set({ founderHandoffResolvedAt: new Date(), updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'handoff_resolved_manually',
    customerId: customer.id,
    properties: { subscriberId },
  })

  return NextResponse.json({ ok: true })
}

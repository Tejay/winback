import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { isDoNotContact } from '@/src/winback/lib/email'
import { logEvent } from '@/src/winback/lib/events'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(and(eq(churnedSubscribers.id, id), eq(churnedSubscribers.customerId, customer.id)))
    .limit(1)
  if (!subscriber) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }
  if (subscriber.status === 'recovered') {
    return NextResponse.json({ error: 'Already recovered' }, { status: 400 })
  }
  if (await isDoNotContact(id)) {
    return NextResponse.json({ error: 'Subscriber has unsubscribed' }, { status: 403 })
  }

  // Spec 50 — stub row so recovery attribution works if the subscriber
  // re-subscribes via the merchant's external email. The merchant sent
  // through their own client, so there's no real Resend message ID.
  await db.insert(emailsSent).values({
    subscriberId: id,
    gmailMessageId: '',
    type: 'manual_external',
    subject: '[external — sent via merchant email client]',
    bodyText: null,
  })

  if (subscriber.status === 'lost') {
    await db
      .update(churnedSubscribers)
      .set({ status: 'contacted', updatedAt: new Date() })
      .where(eq(churnedSubscribers.id, id))
  }

  await logEvent({
    name: 'external_contact_marked',
    customerId: customer.id,
    userId: customer.userId,
    properties: { subscriberId: id, previousStatus: subscriber.status },
  })

  return NextResponse.json({ success: true })
}

import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { sendEmail } from '@/src/winback/lib/email'

export async function POST(
  req: NextRequest,
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
    .where(
      and(
        eq(churnedSubscribers.id, id),
        eq(churnedSubscribers.customerId, customer.id)
      )
    )
    .limit(1)

  if (!subscriber || !subscriber.email) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  const fromName = customer.founderName ?? session.user.name ?? 'The team'
  const { messageId } = await sendEmail({
    to: subscriber.email,
    subject: subscriber.winBackSubject ?? 'Following up',
    body: subscriber.winBackBody ?? 'Hi, just checking in.',
    fromName,
    subscriberId: id,
  })

  await db.insert(emailsSent).values({
    subscriberId: id,
    gmailMessageId: messageId,
    type: 'followup',
    subject: subscriber.winBackSubject ?? 'Following up',
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, id))

  return NextResponse.json({ success: true })
}

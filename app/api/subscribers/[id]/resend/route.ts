import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { sendEmail } from '@/src/winback/lib/email'
import { emailsSent } from '@/lib/schema'

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

  if (!customer?.gmailRefreshToken) {
    return NextResponse.json({ error: 'Gmail not connected' }, { status: 400 })
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

  const refreshToken = decrypt(customer.gmailRefreshToken)
  const { messageId, threadId } = await sendEmail({
    refreshToken,
    to: subscriber.email,
    subject: subscriber.winBackSubject ?? 'Following up',
    body: subscriber.winBackBody ?? 'Hi, just checking in.',
  })

  await db.insert(emailsSent).values({
    subscriberId: id,
    gmailMessageId: messageId,
    gmailThreadId: threadId,
    type: 'followup',
    subject: subscriber.winBackSubject ?? 'Following up',
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, id))

  return NextResponse.json({ success: true })
}

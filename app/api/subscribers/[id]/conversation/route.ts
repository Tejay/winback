import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent, subscriberReplies } from '@/lib/schema'
import { eq, and, desc } from 'drizzle-orm'
import { stripStandardFooter } from '@/src/winback/lib/email'

export type ConversationMessage =
  | {
      direction: 'outbound'
      id: string
      type: string
      subject: string | null
      bodyText: string | null
      sentAt: string
      repliedAt: string | null
    }
  | {
      direction: 'inbound'
      id: string
      body: string
      fromEmail: string | null
      receivedAt: string
      inReplyToEmailId: string | null
    }

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const [subscriber] = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.id, id),
        eq(churnedSubscribers.customerId, customer.id),
      )
    )
    .limit(1)

  if (!subscriber) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  const [outbound, inbound] = await Promise.all([
    db
      .select({
        id: emailsSent.id,
        type: emailsSent.type,
        subject: emailsSent.subject,
        bodyText: emailsSent.bodyText,
        sentAt: emailsSent.sentAt,
        repliedAt: emailsSent.repliedAt,
      })
      .from(emailsSent)
      .where(eq(emailsSent.subscriberId, id))
      .orderBy(desc(emailsSent.sentAt))
      .limit(50),
    db
      .select({
        id: subscriberReplies.id,
        body: subscriberReplies.body,
        fromEmail: subscriberReplies.fromEmail,
        receivedAt: subscriberReplies.receivedAt,
        inReplyToEmailId: subscriberReplies.inReplyToEmailId,
      })
      .from(subscriberReplies)
      .where(eq(subscriberReplies.subscriberId, id))
      .orderBy(desc(subscriberReplies.receivedAt))
      .limit(50),
  ])

  const messages: ConversationMessage[] = [
    ...outbound.map((m): ConversationMessage => ({
      direction: 'outbound',
      id: m.id,
      type: m.type,
      subject: m.subject,
      bodyText: m.bodyText ? stripStandardFooter(m.bodyText) : null,
      sentAt: (m.sentAt ?? new Date(0)).toISOString(),
      repliedAt: m.repliedAt ? m.repliedAt.toISOString() : null,
    })),
    ...inbound.map((m): ConversationMessage => ({
      direction: 'inbound',
      id: m.id,
      body: stripStandardFooter(m.body),
      fromEmail: m.fromEmail,
      receivedAt: m.receivedAt.toISOString(),
      inReplyToEmailId: m.inReplyToEmailId,
    })),
  ].sort((a, b) => {
    const ta = a.direction === 'outbound' ? a.sentAt : a.receivedAt
    const tb = b.direction === 'outbound' ? b.sentAt : b.receivedAt
    return ta.localeCompare(tb)
  })

  return NextResponse.json({ messages })
}

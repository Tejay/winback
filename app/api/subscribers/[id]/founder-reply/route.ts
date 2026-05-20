import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent, users } from '@/lib/schema'
import { eq, and, desc } from 'drizzle-orm'
import { Resend } from 'resend'
import {
  buildFromDisplayName,
  appendStandardFooter,
  ensureSignoff,
  reactivationUrl,
  unsubscribeUrl,
  isDoNotContact,
} from '@/src/winback/lib/email'
import { renderWinbackEmailHtml } from '@/src/winback/lib/email-html'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/subscribers/[id]/founder-reply
 *
 * Founder sends a personal reply inline from the dashboard drawer.
 * Bypasses the AI; goes straight to Resend with In-Reply-To threading
 * to the most recent outbound so the subscriber sees it as a reply in
 * the same Gmail thread.
 *
 * Body: { body: string ≤ 500 chars }
 *
 * Threading: looks up the most-recent wb_emails_sent row for this
 * subscriber and uses its `gmailMessageId` (Resend's message id; the
 * column name is legacy) as In-Reply-To / References.
 *
 * Side effects:
 *   - Resend sends the email
 *   - wb_emails_sent gets a new row with type='founder_reply'
 *   - subscriber.updatedAt is bumped
 *
 * Pre-flight:
 *   - subscriber must not be on the do-not-contact list
 *   - subscriber must have an email address
 *   (No take-over precondition — the founder can reply any time.)
 *
 * Auth: session + ownership check.
 */

const FOUNDER_REPLY_MAX_CHARS = 500

const schema = z.object({
  body: z.string().min(1).max(FOUNDER_REPLY_MAX_CHARS, `Reply exceeds ${FOUNDER_REPLY_MAX_CHARS}-character cap`),
})

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
    return NextResponse.json(
      { error: 'Invalid body', details: parsed.error.issues },
      { status: 400 },
    )
  }

  // Ownership check + load the customer for fromName resolution
  const [customer] = await db
    .select({
      id:           customers.id,
      founderName:  customers.founderName,
      productName:  customers.productName,
      userName:     users.name,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const [sub] = await db
    .select()
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
  if (!sub.email) {
    return NextResponse.json({ error: 'Subscriber has no email on file' }, { status: 400 })
  }
  if (await isDoNotContact(subscriberId)) {
    return NextResponse.json({ error: 'Subscriber is on the do-not-contact list' }, { status: 409 })
  }

  // No take-over precondition — the founder can reply at any time. The AI
  // sends one listen-only exit email then stays quiet, so there's no active
  // AI conversation to "take over" from. (Drawer redesign.)

  // Look up the most-recent outbound email so we can thread our reply
  // under it. References stays equivalent to In-Reply-To since the
  // outbound chain is shallow (≤3 messages typically).
  const [lastOutbound] = await db
    .select({
      gmailMessageId: emailsSent.gmailMessageId,
      subject:        emailsSent.subject,
    })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, subscriberId))
    .orderBy(desc(emailsSent.sentAt))
    .limit(1)

  const fromName = buildFromDisplayName({
    founderName: customer.founderName ?? customer.userName,
    productName: customer.productName,
  })
  const from        = `${fromName} <reply+${subscriberId}@reply.winbackflow.co>`
  const subject     = lastOutbound?.subject
    ? (lastOutbound.subject.startsWith('Re:') ? lastOutbound.subject : `Re: ${lastOutbound.subject}`)
    : `Following up`
  // append-if-missing: respects the founder's own sign-off if they typed one,
  // adds the canonical one only when absent.
  const signedBody  = ensureSignoff(parsed.data.body, fromName)
  const fullBody    = appendStandardFooter(signedBody, subscriberId, fromName)
  const html        = renderWinbackEmailHtml({
    body:            signedBody,
    reactivationUrl: reactivationUrl(subscriberId),
    unsubscribeUrl:  unsubscribeUrl(subscriberId),
  })

  const headers: Record<string, string> = {
    'List-Unsubscribe': `<${unsubscribeUrl(subscriberId)}>, <mailto:unsubscribe@winbackflow.co>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
  if (lastOutbound?.gmailMessageId) {
    headers['In-Reply-To'] = `<${lastOutbound.gmailMessageId}>`
    headers['References']  = `<${lastOutbound.gmailMessageId}>`
  }

  const resendKey = process.env.RESEND_API_KEY
  if (!resendKey) {
    return NextResponse.json({ error: 'RESEND_API_KEY not configured' }, { status: 503 })
  }
  const resend = new Resend(resendKey)
  const res = await resend.emails.send({
    from,
    to:      sub.email,
    subject,
    text:    fullBody,
    html,
    headers,
  })
  if (res.error) {
    await logEvent({
      name: 'email_send_failed',
      properties: {
        subscriberId,
        type:         'founder_reply',
        errorMessage: res.error.message,
      },
    })
    return NextResponse.json({ error: `Send failed: ${res.error.message}` }, { status: 502 })
  }

  await db.insert(emailsSent).values({
    subscriberId,
    gmailMessageId: res.data?.id ?? '',
    gmailThreadId:  lastOutbound?.gmailMessageId ?? null,
    type:           'founder_reply',
    subject,
    bodyText:       fullBody,
  })

  await db
    .update(churnedSubscribers)
    .set({ updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'founder_reply_sent',
    customerId: customer.id,
    properties: {
      subscriberId,
      bodyLength: parsed.data.body.length,
      messageId:  res.data?.id ?? '',
    },
  })

  return NextResponse.json({ ok: true, messageId: res.data?.id ?? '' })
}

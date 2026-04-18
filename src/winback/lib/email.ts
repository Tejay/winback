import { Resend } from 'resend'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers, customers } from '@/lib/schema'
import { eq, and, count } from 'drizzle-orm'
import { ClassificationResult } from './types'
import { generateUnsubscribeToken } from './unsubscribe-token'
import { logEvent } from './events'

/** Maximum follow-up emails per subscriber. After this, flag for founder. */
const MAX_FOLLOWUPS = 2

function getResendClient() {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY is not set')
  return new Resend(key)
}

export function unsubscribeUrl(subscriberId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
  const token = generateUnsubscribeToken(subscriberId)
  return `${base}/api/unsubscribe/${subscriberId}?t=${token}`
}

export function reactivationUrl(subscriberId: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
  return `${base}/api/reactivate/${subscriberId}`
}

function listUnsubscribeHeaders(subscriberId: string) {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl(subscriberId)}>, <mailto:unsubscribe@winbackflow.co>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

/**
 * Appends the standard footer (reactivation link + sign-off + unsubscribe link)
 * to an email body. Used by sendEmail(), sendReplyEmail(), and the dev test
 * harness so they all produce identical output.
 *
 * Note: dunning emails use a different footer (update-payment link, no
 * reactivation) — see sendDunningEmail() for that variant.
 */
export function appendStandardFooter(body: string, subscriberId: string, fromName: string): string {
  return `${body}

Ready to give us another try? Resubscribe here:
${reactivationUrl(subscriberId)}

— ${fromName}

— — —
If you'd rather not hear from us, unsubscribe: ${unsubscribeUrl(subscriberId)}`
}

/**
 * Returns true if the subscriber has opted out. Callers must skip sending.
 */
async function isDoNotContact(subscriberId: string): Promise<boolean> {
  const [row] = await db
    .select({ dnc: churnedSubscribers.doNotContact })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  return row?.dnc ?? false
}

/**
 * Returns true if the subscriber's customer (the Winback user) has paused
 * sending from Settings. Callers must skip sending.
 */
export async function isCustomerPausedForSubscriber(subscriberId: string): Promise<boolean> {
  const [row] = await db
    .select({ pausedAt: customers.pausedAt })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  return !!row?.pausedAt
}

export async function sendEmail(params: {
  to: string
  subject: string
  body: string
  fromName: string
  subscriberId: string
}): Promise<{ messageId: string }> {
  const { to, subject, body, fromName, subscriberId } = params

  if (await isDoNotContact(subscriberId)) {
    console.log('Skipping email — subscriber unsubscribed:', subscriberId)
    return { messageId: '' }
  }

  const resend = getResendClient()

  // Use reply+{subscriberId}@winbackflow.co so inbound webhook can match replies
  const from = `${fromName} <reply+${subscriberId}@winbackflow.co>`

  const fullBody = appendStandardFooter(body, subscriberId, fromName)

  const res = await resend.emails.send({
    from,
    to,
    subject,
    text: fullBody,
    headers: listUnsubscribeHeaders(subscriberId),
  })

  if (res.error) {
    throw new Error(`Resend error: ${res.error.message}`)
  }

  return { messageId: res.data?.id ?? '' }
}

export async function scheduleExitEmail(params: {
  subscriberId: string
  email: string
  classification: ClassificationResult
  fromName: string
}): Promise<void> {
  const { subscriberId, email, classification, fromName } = params

  if (!classification.firstMessage) {
    console.log('No firstMessage (suppressed), skipping email')
    return
  }

  if (await isDoNotContact(subscriberId)) {
    console.log('Skipping exit email — subscriber unsubscribed:', subscriberId)
    return
  }

  if (await isCustomerPausedForSubscriber(subscriberId)) {
    console.log('Skipping exit email — customer has paused sending:', subscriberId)
    return
  }

  const { subject, body } = classification.firstMessage

  const { messageId } = await sendEmail({
    to: email,
    subject,
    body,
    fromName,
    subscriberId,
  })

  // sendEmail returns empty messageId if DNC — shouldn't happen here (we pre-checked) but guard anyway
  if (!messageId) return

  await db.insert(emailsSent).values({
    subscriberId,
    gmailMessageId: messageId,
    type: 'exit',
    subject,
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'email_sent',
    properties: { subscriberId, emailType: 'exit', subject, messageId },
  })
}

/**
 * Send a follow-up email in the same thread after re-classification.
 * Uses In-Reply-To / References headers so email clients thread it.
 * Respects DNC, customer-paused, and max follow-up limits.
 *
 * Returns `{ sent: true }` if email was sent, `{ sent: false, reason }` otherwise.
 * When the follow-up limit is reached, notifies the founder via email.
 */
export async function sendReplyEmail(params: {
  subscriberId: string
  email: string
  classification: ClassificationResult
  fromName: string
  founderEmail?: string
}): Promise<{ sent: boolean; reason?: string }> {
  const { subscriberId, email, classification, fromName, founderEmail } = params

  if (!classification.firstMessage) {
    console.log('No firstMessage after re-classification, skipping reply email')
    return { sent: false, reason: 'no_first_message' }
  }

  if (classification.tier === 4) {
    console.log('Tier 4 on re-classification, suppressing reply email:', subscriberId)
    return { sent: false, reason: 'tier_4_suppress' }
  }

  if (await isDoNotContact(subscriberId)) {
    console.log('Skipping reply email — subscriber unsubscribed:', subscriberId)
    return { sent: false, reason: 'do_not_contact' }
  }

  if (await isCustomerPausedForSubscriber(subscriberId)) {
    console.log('Skipping reply email — customer has paused sending:', subscriberId)
    return { sent: false, reason: 'customer_paused' }
  }

  // Check follow-up limit — max 2 per subscriber
  const [followupCount] = await db
    .select({ total: count() })
    .from(emailsSent)
    .where(
      and(
        eq(emailsSent.subscriberId, subscriberId),
        eq(emailsSent.type, 'followup'),
      )
    )

  if ((followupCount?.total ?? 0) >= MAX_FOLLOWUPS) {
    console.log(`Follow-up limit reached (${MAX_FOLLOWUPS}) for subscriber:`, subscriberId, '— flagging for founder')

    // Notify the founder that this subscriber needs personal attention
    if (founderEmail) {
      try {
        const resend = getResendClient()
        await resend.emails.send({
          from: `Winback <noreply@winbackflow.co>`,
          to: founderEmail,
          subject: `[Winback] ${email} needs your attention`,
          text: `A subscriber has replied ${MAX_FOLLOWUPS}+ times and the AI follow-up limit has been reached.

Subscriber: ${email}
Their latest reply: "${classification.firstMessage.body.slice(0, 200)}..."

The AI generated a response but didn't send it. This one needs your personal touch — reply to them directly.

You can see the full thread in your Resend dashboard or your inbox.`,
        })
        console.log('Flagged subscriber to founder:', founderEmail)
      } catch (notifyErr) {
        console.error('Failed to notify founder:', notifyErr)
      }
    }

    return { sent: false, reason: 'followup_limit_reached' }
  }

  // Look up the original email to thread the reply
  const [originalEmail] = await db
    .select({ messageId: emailsSent.gmailMessageId })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, subscriberId))
    .orderBy(emailsSent.sentAt)
    .limit(1)

  const { subject, body } = classification.firstMessage
  const resend = getResendClient()

  const from = `${fromName} <reply+${subscriberId}@winbackflow.co>`
  const fullBody = appendStandardFooter(body, subscriberId, fromName)

  // Thread headers — if we have the original message ID, use it
  const headers: Record<string, string> = {
    ...listUnsubscribeHeaders(subscriberId),
  }
  if (originalEmail?.messageId) {
    headers['In-Reply-To'] = `<${originalEmail.messageId}>`
    headers['References'] = `<${originalEmail.messageId}>`
  }

  const res = await resend.emails.send({
    from,
    to: email,
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    text: fullBody,
    headers,
  })

  if (res.error) {
    throw new Error(`Resend error: ${res.error.message}`)
  }

  await db.insert(emailsSent).values({
    subscriberId,
    gmailMessageId: res.data?.id ?? '',
    gmailThreadId: originalEmail?.messageId ?? null,
    type: 'followup',
    subject,
  })

  logEvent({
    name: 'email_sent',
    properties: { subscriberId, emailType: 'followup', subject, messageId: res.data?.id ?? '' },
  })

  console.log('Sent follow-up reply email to subscriber:', subscriberId)
  return { sent: true }
}

export async function sendDunningEmail(params: {
  subscriberId: string
  email: string
  customerName: string | null
  planName: string
  amountDue: number
  currency: string
  nextRetryDate: Date | null
  fromName: string
}): Promise<void> {
  const { subscriberId, email, customerName, planName, amountDue, currency, nextRetryDate, fromName } = params

  if (await isDoNotContact(subscriberId)) {
    console.log('Skipping dunning email — subscriber unsubscribed:', subscriberId)
    return
  }

  const resend = getResendClient()

  const name = customerName ?? 'there'
  const amount = (amountDue / 100).toFixed(2)
  const updateLink = `${process.env.NEXT_PUBLIC_APP_URL}/api/update-payment/${subscriberId}`
  const unsubLink = unsubscribeUrl(subscriberId)
  const from = `${fromName} <noreply@winbackflow.co>`

  let subject: string
  let body: string

  if (nextRetryDate) {
    const retryDateStr = nextRetryDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    subject = 'Your payment didn\'t go through'
    body = `Hi ${name},

We tried to charge your card for ${planName} (${amount} ${currency.toUpperCase()}) but it didn't go through. This usually happens when a card expires or the bank declines it.

You can update your payment method here:
${updateLink}

We'll try again on ${retryDateStr} — updating before then means no interruption to your service.

If you have any questions, just reply to this email.

— ${fromName}

— — —
If you'd rather not hear from us, unsubscribe: ${unsubLink}`
  } else {
    subject = 'Action needed — your subscription is at risk'
    body = `Hi ${name},

This was our last attempt to charge your card for ${planName} (${amount} ${currency.toUpperCase()}). To keep your subscription active, please update your payment method:

${updateLink}

— ${fromName}

— — —
If you'd rather not hear from us, unsubscribe: ${unsubLink}`
  }

  const res = await resend.emails.send({
    from,
    to: email,
    subject,
    text: body,
    headers: listUnsubscribeHeaders(subscriberId),
  })

  if (res.error) {
    throw new Error(`Resend error: ${res.error.message}`)
  }

  await db.insert(emailsSent).values({
    subscriberId,
    gmailMessageId: res.data?.id ?? '',
    type: 'dunning',
    subject,
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'email_sent',
    properties: { subscriberId, emailType: 'dunning', subject, messageId: res.data?.id ?? '' },
  })
}

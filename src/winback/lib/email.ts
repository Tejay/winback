import { Resend } from 'resend'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { ClassificationResult } from './types'

function getResendClient() {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY is not set')
  return new Resend(key)
}

export async function sendEmail(params: {
  to: string
  subject: string
  body: string
  fromName: string
  subscriberId: string
}): Promise<{ messageId: string }> {
  const { to, subject, body, fromName, subscriberId } = params
  const resend = getResendClient()

  // Use reply+{subscriberId}@winbackflow.co so inbound webhook can match replies
  const from = `${fromName} <reply+${subscriberId}@winbackflow.co>`

  // Append reactivation link to every email
  const reactivationLink = `${process.env.NEXT_PUBLIC_APP_URL}/api/reactivate/${subscriberId}`
  const fullBody = `${body}

Ready to give us another try? Resubscribe here:
${reactivationLink}

— ${fromName}`

  const res = await resend.emails.send({
    from,
    to,
    subject,
    text: fullBody,
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

  const { subject, body } = classification.firstMessage

  const { messageId } = await sendEmail({
    to: email,
    subject,
    body,
    fromName,
    subscriberId,
  })

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
  const resend = getResendClient()

  const name = customerName ?? 'there'
  const amount = (amountDue / 100).toFixed(2)
  const updateLink = `${process.env.NEXT_PUBLIC_APP_URL}/api/update-payment/${subscriberId}`
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

— ${fromName}`
  } else {
    subject = 'Action needed — your subscription is at risk'
    body = `Hi ${name},

This was our last attempt to charge your card for ${planName} (${amount} ${currency.toUpperCase()}). To keep your subscription active, please update your payment method:

${updateLink}

— ${fromName}`
  }

  const res = await resend.emails.send({ from, to: email, subject, text: body })

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
}

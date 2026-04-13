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

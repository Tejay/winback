import { google } from 'googleapis'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { ClassificationResult } from './types'

function getOAuth2Client(refreshToken: string) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  )
  oauth2.setCredentials({ refresh_token: refreshToken })
  return oauth2
}

export async function sendEmail(params: {
  refreshToken: string
  to: string
  subject: string
  body: string
}): Promise<{ messageId: string; threadId: string }> {
  const { refreshToken, to, subject, body } = params

  const auth = getOAuth2Client(refreshToken)
  const gmail = google.gmail({ version: 'v1', auth })

  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body,
  ].join('\r\n')

  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  })

  return {
    messageId: res.data.id ?? '',
    threadId: res.data.threadId ?? '',
  }
}

export async function scheduleExitEmail(params: {
  subscriberId: string
  email: string
  classification: ClassificationResult
  refreshToken: string
}): Promise<void> {
  const { subscriberId, email, classification, refreshToken } = params

  if (!classification.firstMessage) {
    console.log('No firstMessage (suppressed), skipping email')
    return
  }

  const { subject, body, sendDelaySecs } = classification.firstMessage

  // TODO: replace setTimeout with a persistent job queue (e.g. BullMQ) before production
  setTimeout(async () => {
    try {
      const { messageId, threadId } = await sendEmail({
        refreshToken,
        to: email,
        subject,
        body,
      })

      await db.insert(emailsSent).values({
        subscriberId,
        gmailMessageId: messageId,
        gmailThreadId: threadId,
        type: 'exit',
        subject,
      })

      await db
        .update(churnedSubscribers)
        .set({ status: 'contacted', updatedAt: new Date() })
        .where(eq(churnedSubscribers.id, subscriberId))
    } catch (err) {
      console.error('Failed to send exit email:', err)
    }
  }, sendDelaySecs * 1000)
}

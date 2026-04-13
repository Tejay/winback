import { google } from 'googleapis'
import { db } from '@/lib/db'
import { customers, emailsSent, churnedSubscribers } from '@/lib/schema'
import { eq, isNull, isNotNull, gt, and } from 'drizzle-orm'
import { decrypt } from './encryption'
import { classifySubscriber } from './classifier'
import { SubscriberSignals } from './types'

export async function pollAllCustomerReplies(): Promise<{
  processed: number
  repliesFound: number
}> {
  const allCustomers = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.onboardingComplete, true),
        // Only customers with Gmail connected
        isNotNull(customers.gmailRefreshToken)
      )
    )

  let processed = 0
  let repliesFound = 0

  for (const customer of allCustomers) {
    if (!customer.gmailRefreshToken) continue

    try {
      const decryptedToken = decrypt(customer.gmailRefreshToken)
      const result = await pollCustomerReplies(customer.id, decryptedToken)
      processed++
      repliesFound += result.repliesFound
    } catch (err) {
      console.error(`Reply poll failed for customer ${customer.id}:`, err)
    }
  }

  return { processed, repliesFound }
}

export async function pollCustomerReplies(
  customerId: string,
  gmailRefreshToken: string
): Promise<{ repliesFound: number }> {
  const thirtyDaysAgo = new Date()
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  const pendingEmails = await db
    .select()
    .from(emailsSent)
    .where(
      and(
        isNull(emailsSent.repliedAt),
        gt(emailsSent.sentAt, thirtyDaysAgo)
      )
    )

  if (pendingEmails.length === 0) return { repliesFound: 0 }

  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  )
  oauth2.setCredentials({ refresh_token: gmailRefreshToken })
  const gmail = google.gmail({ version: 'v1', auth: oauth2 })

  let repliesFound = 0

  for (const email of pendingEmails) {
    if (!email.gmailThreadId) continue

    try {
      const thread = await gmail.users.threads.get({
        userId: 'me',
        id: email.gmailThreadId,
      })

      const messages = thread.data.messages ?? []
      if (messages.length <= 1) continue

      // Check if any message is NOT from the sender (i.e. a reply from the customer)
      const profile = await gmail.users.getProfile({ userId: 'me' })
      const senderEmail = profile.data.emailAddress?.toLowerCase()

      const replyMessage = messages.find((msg) => {
        const from = msg.payload?.headers
          ?.find((h) => h.name?.toLowerCase() === 'from')
          ?.value?.toLowerCase()
        return from && senderEmail && !from.includes(senderEmail)
      })

      if (!replyMessage) continue

      // Extract reply body
      const bodyData = replyMessage.payload?.body?.data
        ?? replyMessage.payload?.parts?.[0]?.body?.data
        ?? ''
      const decodedBody = Buffer.from(bodyData, 'base64').toString('utf8')
      const replyText = stripQuotedLines(decodedBody)

      await processReply(email.subscriberId, replyText)
      repliesFound++
    } catch (err) {
      console.error(`Failed to check thread ${email.gmailThreadId}:`, err)
    }
  }

  return { repliesFound }
}

export function stripQuotedLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()
}

async function processReply(subscriberId: string, replyText: string) {
  // Update email replied_at
  await db
    .update(emailsSent)
    .set({ repliedAt: new Date() })
    .where(eq(emailsSent.subscriberId, subscriberId))

  // Save reply text to subscriber
  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!subscriber) return

  await db
    .update(churnedSubscribers)
    .set({ replyText, updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  // Re-classify with reply text as primary signal
  try {
    const signals: SubscriberSignals = {
      stripeCustomerId: subscriber.stripeCustomerId,
      stripeSubscriptionId: subscriber.stripeSubscriptionId ?? '',
      stripePriceId: subscriber.stripePriceId ?? null,
      email: subscriber.email,
      name: subscriber.name,
      planName: subscriber.planName ?? 'Unknown',
      mrrCents: subscriber.mrrCents,
      tenureDays: subscriber.tenureDays ?? 0,
      everUpgraded: subscriber.everUpgraded ?? false,
      nearRenewal: subscriber.nearRenewal ?? false,
      paymentFailures: subscriber.paymentFailures ?? 0,
      previousSubs: subscriber.previousSubs ?? 0,
      stripeEnum: subscriber.stripeEnum,
      stripeComment: subscriber.stripeComment,
      cancelledAt: subscriber.cancelledAt ?? new Date(),
    }

    // Get customer context
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, subscriber.customerId))
      .limit(1)

    const classification = await classifySubscriber(signals, {
      founderName: customer?.founderName ?? undefined,
      productName: customer?.productName ?? undefined,
      changelog: customer?.changelogText ?? undefined,
    })

    await db
      .update(churnedSubscribers)
      .set({
        tier: classification.tier,
        confidence: String(classification.confidence),
        triggerKeyword: classification.triggerKeyword,
        winBackSubject: classification.winBackSubject,
        winBackBody: classification.winBackBody,
        cancellationReason: classification.cancellationReason,
        cancellationCategory: classification.cancellationCategory,
        updatedAt: new Date(),
      })
      .where(eq(churnedSubscribers.id, subscriberId))
  } catch (err) {
    console.error('Re-classification after reply failed:', err)
  }
}

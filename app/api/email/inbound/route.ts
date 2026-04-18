import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers, customers, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { sendReplyEmail } from '@/src/winback/lib/email'
import { SubscriberSignals } from '@/src/winback/lib/types'
import { logEvent } from '@/src/winback/lib/events'

export async function POST(req: Request) {
  const body = await req.json()

  // Resend inbound webhook payload — to can be string or array
  const to = Array.isArray(body.to) ? body.to[0] : (body.to ?? '')
  const from = body.from ?? ''
  const text = body.text ?? body.plain_text ?? ''

  // Extract subscriberId from the "to" address: reply+{subscriberId}@winbackflow.co
  const match = to.match(/reply\+([a-f0-9-]+)@/i)
  if (!match) {
    console.log('Inbound email: no subscriber ID in to address:', to)
    return NextResponse.json({ received: true, processed: false })
  }

  const subscriberId = match[1]
  console.log('Inbound reply for subscriber:', subscriberId, 'from:', from)

  // Strip quoted lines from reply
  const replyText = text
    .split('\n')
    .filter((line: string) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()

  if (!replyText) {
    console.log('Empty reply text after stripping quotes')
    return NextResponse.json({ received: true, processed: false })
  }

  // Update email replied_at
  await db
    .update(emailsSent)
    .set({ repliedAt: new Date() })
    .where(eq(emailsSent.subscriberId, subscriberId))

  logEvent({
    name: 'email_replied',
    properties: { subscriberId, replyTextLength: replyText.length },
  })

  // Save reply text
  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!subscriber) {
    console.log('Subscriber not found:', subscriberId)
    return NextResponse.json({ received: true, processed: false })
  }

  await db
    .update(churnedSubscribers)
    .set({ replyText, updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  // Re-classify with reply text
  try {
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, subscriber.customerId))
      .limit(1)

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
      replyText: replyText,
      billingPortalClicked: !!subscriber.billingPortalClickedAt,
      cancelledAt: subscriber.cancelledAt ?? new Date(),
    }

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
        triggerNeed: classification.triggerNeed,
        winBackSubject: classification.winBackSubject,
        winBackBody: classification.winBackBody,
        cancellationReason: classification.cancellationReason,
        cancellationCategory: classification.cancellationCategory,
        updatedAt: new Date(),
      })
      .where(eq(churnedSubscribers.id, subscriberId))

    console.log('Re-classified subscriber after reply:', subscriberId, 'tier:', classification.tier, 'firstMessage:', !!classification.firstMessage, 'winBackBody:', !!classification.winBackBody)

    // The LLM may put re-classification content in firstMessage OR in
    // winBackSubject/winBackBody. Build the message from whichever is present.
    const replyMessage = classification.firstMessage
      ?? (classification.winBackBody
        ? { subject: classification.winBackSubject, body: classification.winBackBody, sendDelaySecs: 0 }
        : null)

    // Send follow-up email in the same thread with the re-classified content.
    // Respects a max of 2 follow-ups per subscriber — after that, flags the founder.
    if (classification.tier !== 4 && replyMessage && subscriber.email) {
      const replyClassification = { ...classification, firstMessage: replyMessage }

      // Look up the founder's email to notify them if the follow-up limit is hit
      let founderEmail: string | undefined
      if (customer?.userId) {
        const [user] = await db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, customer.userId))
          .limit(1)
        founderEmail = user?.email
      }

      try {
        const result = await sendReplyEmail({
          subscriberId,
          email: subscriber.email,
          classification: replyClassification,
          fromName: customer?.founderName ?? 'The team',
          founderEmail,
        })
        if (!result.sent) {
          console.log('Reply email not sent:', result.reason)
        }
      } catch (emailErr) {
        console.error('Failed to send reply email:', emailErr)
      }
    } else {
      console.log('Skipping reply email — tier:', classification.tier, 'replyMessage:', !!replyMessage, 'email:', !!subscriber.email)
    }
  } catch (err) {
    console.error('Re-classification after reply failed:', err)
  }

  return NextResponse.json({ received: true, processed: true })
}

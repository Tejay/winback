// Simulates the inbound webhook handler end-to-end without going through
// Resend/Svix. Mirrors the logic in app/api/email/inbound/route.ts so the
// drawer + AI back-and-forth can be exercised in dev without configuring
// the inbound webhook.
//
// Usage:
//   tsx --env-file=.env.local scripts/simulate-inbound-reply.ts <subscriberId> "<reply text>"

import 'dotenv/config'
import { and, count, desc, eq } from 'drizzle-orm'
import { db } from '../lib/db'
import { customers, churnedSubscribers, emailsSent, subscriberReplies, users } from '../lib/schema'
import { classifySubscriber } from '../src/winback/lib/classifier'
import { sendReplyEmail, buildFromDisplayName } from '../src/winback/lib/email'
import { SubscriberSignals } from '../src/winback/lib/types'
import { buildConversationThread } from '../src/winback/lib/conversation'
import { deriveTriggerNeedConfidence } from '../src/winback/lib/improvement-match'

async function main(): Promise<void> {
  const subscriberId = process.argv[2]
  const replyBody    = process.argv[3]
  if (!subscriberId || !replyBody) {
    console.error('Usage: tsx --env-file=.env.local scripts/simulate-inbound-reply.ts <subscriberId> "<reply text>"')
    process.exit(1)
  }

  console.log(`Simulating inbound reply for ${subscriberId}`)
  console.log(`Reply body: "${replyBody}"`)

  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  if (!subscriber) { console.error('Subscriber not found'); process.exit(1) }

  // 1. Insert the reply row
  await db.insert(subscriberReplies).values({
    subscriberId,
    body:      replyBody,
    fromEmail: subscriber.email,
  })
  console.log('  ✓ inserted reply row')

  // 2. Bump lastEngagementAt
  await db
    .update(churnedSubscribers)
    .set({ lastEngagementAt: new Date(), updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  // 3. Resolve customer for fromName
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, subscriber.customerId))
    .limit(1)

  const [sentSoFar] = await db
    .select({ total: count() })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, subscriberId))

  // 4. Re-classify with the new reply in conversation thread
  const signals: SubscriberSignals = {
    stripeCustomerId:     subscriber.stripeCustomerId,
    stripeSubscriptionId: subscriber.stripeSubscriptionId ?? '',
    stripePriceId:        subscriber.stripePriceId ?? null,
    email:                subscriber.email,
    name:                 subscriber.name,
    planName:             subscriber.planName ?? 'Unknown',
    mrrCents:             subscriber.mrrCents,
    tenureDays:           subscriber.tenureDays ?? 0,
    everUpgraded:         subscriber.everUpgraded ?? false,
    nearRenewal:          subscriber.nearRenewal ?? false,
    paymentFailures:      subscriber.paymentFailures ?? 0,
    previousSubs:         subscriber.previousSubs ?? 0,
    stripeEnum:           subscriber.stripeEnum,
    stripeComment:        subscriber.stripeComment,
    conversationThread:   await buildConversationThread(subscriberId),
    billingPortalClicked: !!subscriber.billingPortalClickedAt,
    cancelledAt:          subscriber.cancelledAt ?? new Date(),
    emailsSent:           sentSoFar?.total ?? 0,
  }

  console.log('  → calling classifySubscriber()...')
  const classification = await classifySubscriber(signals, {
    founderName:  customer?.founderName ?? undefined,
    productName:  customer?.productName ?? undefined,
  })
  console.log(`  ✓ classified: tier=${classification.tier} confidence=${classification.confidence} handoff=${classification.handoff}`)
  if (classification.handoffReasoning) console.log(`    reasoning: ${classification.handoffReasoning}`)

  // 5. Persist new classification
  await db
    .update(churnedSubscribers)
    .set({
      tier:                  classification.tier,
      confidence:            String(classification.confidence),
      triggerKeyword:        classification.triggerKeyword,
      triggerNeed:           classification.triggerNeed,
      triggerNeedConfidence: deriveTriggerNeedConfidence(classification),
      winBackSubject:        classification.winBackSubject,
      winBackBody:           classification.winBackBody,
      cancellationReason:    classification.cancellationReason,
      cancellationCategory:  classification.cancellationCategory,
      handoffReasoning:      classification.handoffReasoning,
      recoveryLikelihood:    classification.recoveryLikelihood,
      updatedAt:             new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  // 6. Check pause/handoff state — if either, skip auto-reply
  const isHandedOff = subscriber.founderHandoffAt && !subscriber.founderHandoffResolvedAt
  const isPaused    = subscriber.aiPausedUntil && subscriber.aiPausedUntil.getTime() > Date.now()

  if (isHandedOff || isPaused) {
    console.log(`  ⚠ handoff=${!!isHandedOff} paused=${!!isPaused} — no auto-reply`)
    process.exit(0)
  }

  // 7. Check if last outbound was re-engagement — if so, no auto-reply
  const [lastEmail] = await db
    .select({ type: emailsSent.type })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, subscriberId))
    .orderBy(desc(emailsSent.sentAt))
    .limit(1)
  if (lastEmail?.type === 'reengagement') {
    console.log('  ⚠ last email was re-engagement — silent reclassify, no auto-reply')
    process.exit(0)
  }

  // 8. Build replyMessage from firstMessage OR winBackBody
  const replyMessage = classification.firstMessage
    ?? (classification.winBackBody
      ? { subject: classification.winBackSubject!, body: classification.winBackBody, sendDelaySecs: 0 }
      : null)

  if (classification.tier === 4 || !replyMessage || !subscriber.email) {
    console.log(`  ⚠ skipping send — tier=${classification.tier} replyMessage=${!!replyMessage} email=${!!subscriber.email}`)
    process.exit(0)
  }

  // 9. Send the follow-up
  let founderEmail: string | undefined
  if (customer?.userId) {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, customer.userId)).limit(1)
    founderEmail = u?.email
  }

  console.log('  → calling sendReplyEmail()...')
  const result = await sendReplyEmail({
    subscriberId,
    email: subscriber.email,
    classification: { ...classification, firstMessage: replyMessage },
    fromName: buildFromDisplayName({
      founderName: customer?.founderName,
      productName: customer?.productName,
    }),
    founderEmail,
  })
  console.log(`  ✓ sendReplyEmail: sent=${result.sent}${result.reason ? ' reason=' + result.reason : ''}`)

  console.log('\nDone. Inspect with:')
  console.log(`  tsx --env-file=.env.local scripts/inspect-test-sub.ts ${subscriberId}`)
}

main()
  .catch((e) => { console.error('Crash:', e); process.exit(1) })
  .finally(() => process.exit(0))

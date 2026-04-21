import { Resend } from 'resend'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers, customers, users } from '@/lib/schema'
import { eq, and, count } from 'drizzle-orm'
import { ClassificationResult } from './types'
import { generateUnsubscribeToken } from './unsubscribe-token'
import { logEvent } from './events'

/** Maximum follow-up emails per subscriber. After this, flag for founder. */
const MAX_FOLLOWUPS = 2

/**
 * Resolves the email address that should receive founder notifications
 * (handoff alerts, reply-after-handoff alerts, etc.) for a customer.
 *
 * Order of preference:
 *   1. customer.notificationEmail (set in Settings — spec 21c)
 *   2. user.email (the founder's signin email)
 *   3. null if neither exists (caller should skip sending)
 */
export async function resolveFounderNotificationEmail(customerId: string): Promise<string | null> {
  const [row] = await db
    .select({
      notificationEmail: customers.notificationEmail,
      userEmail: users.email,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(customers.id, customerId))
    .limit(1)
  return row?.notificationEmail ?? row?.userEmail ?? null
}

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

/**
 * Spec 22a — Returns true if the subscriber has an active AI pause
 * (ai_paused_until > now). Callers must skip sending automated emails.
 *
 * This is orthogonal to handoff — a handed-off sub may or may not be paused,
 * and a paused sub may or may not be handed-off. Both gates are independent.
 */
export async function isAiPaused(subscriberId: string): Promise<boolean> {
  const [row] = await db
    .select({ aiPausedUntil: churnedSubscribers.aiPausedUntil })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  if (!row?.aiPausedUntil) return false
  return row.aiPausedUntil.getTime() > Date.now()
}

/**
 * Hand off a subscriber to the founder. Idempotent: if already handed off,
 * skips the state update and the notification. Used by both the initial
 * classification path (scheduleExitEmail pre-gate) and the reply path
 * (sendReplyEmail) so the behaviour stays consistent.
 *
 * Persists the classifier's handoffReasoning + recoveryLikelihood so the
 * founder sees the AI's actual judgment, not a bucketed label.
 */
async function triggerFounderHandoff(params: {
  subscriberId: string
  classification: ClassificationResult
  fromName: string
  trigger: 'initial_classification' | 'reply_classification'
}): Promise<void> {
  const { subscriberId, classification, fromName, trigger } = params

  const [sub] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!sub) {
    console.log('Hand-off skipped — subscriber not found:', subscriberId)
    return
  }

  if (sub.founderHandoffAt) {
    console.log('Hand-off skipped — already handed off:', subscriberId)
    return
  }

  await db
    .update(churnedSubscribers)
    .set({
      founderHandoffAt:   new Date(),
      aiPausedAt:         new Date(),
      aiPausedUntil:      new Date('9999-12-31T00:00:00Z'),  // indefinite sentinel
      aiPausedReason:     'handoff',
      handoffReasoning:   classification.handoffReasoning,
      recoveryLikelihood: classification.recoveryLikelihood,
      updatedAt:          new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'founder_handoff_triggered',
    customerId: sub.customerId,
    properties: {
      subscriberId,
      trigger,
      recoveryLikelihood: classification.recoveryLikelihood,
      reasoningExcerpt:   classification.handoffReasoning.slice(0, 200),
    },
  })

  try {
    const recipient = await resolveFounderNotificationEmail(sub.customerId)
    if (!recipient) {
      console.log('Hand-off: no recipient email resolved for customer', sub.customerId)
      return
    }
    const { buildHandoffNotification } = await import('./founder-handoff-email')
    const { subject, body } = await buildHandoffNotification({
      subscriber: {
        id: sub.id,
        email: sub.email,
        name: sub.name,
        planName: sub.planName,
        mrrCents: sub.mrrCents,
        cancellationReason: sub.cancellationReason,
        triggerNeed: sub.triggerNeed,
        cancelledAt: sub.cancelledAt,
        stripeComment: sub.stripeComment,
        replyText: sub.replyText,
      },
      founderName: fromName,
      handoffReasoning:   classification.handoffReasoning,
      recoveryLikelihood: classification.recoveryLikelihood,
    })
    const resend = getResendClient()
    await resend.emails.send({
      from: `Winback <noreply@winbackflow.co>`,
      to: recipient,
      subject,
      text: body,
    })
    console.log('Handoff notification sent to:', recipient)
  } catch (notifyErr) {
    console.error('Failed to send handoff notification:', notifyErr)
  }
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

  // Spec 22a — respect per-subscriber AI pause
  if (await isAiPaused(subscriberId)) {
    console.log('Skipping email — AI paused for subscriber:', subscriberId)
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

  // Spec 22a — per-subscriber AI pause
  if (await isAiPaused(subscriberId)) {
    console.log('Skipping exit email — AI paused for subscriber:', subscriberId)
    return
  }

  // AI-decided hand-off on the initial pass. Rare — requires a strong signal
  // in stripe_comment alone — but possible (e.g., "I need to talk to someone
  // about enterprise pricing"). Skip the exit email and route straight to
  // the founder. Burns 0 of the 3-email budget.
  if (classification.handoff) {
    console.log('AI decided initial hand-off for subscriber:', subscriberId)
    await triggerFounderHandoff({
      subscriberId,
      classification,
      fromName,
      trigger: 'initial_classification',
    })
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
  /** @deprecated since spec 21c — recipient now resolved via customers.notificationEmail. Kept for backwards compat. */
  founderEmail?: string
}): Promise<{ sent: boolean; reason?: string }> {
  const { subscriberId, email, classification, fromName } = params

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

  // Spec 22a — per-subscriber AI pause
  if (await isAiPaused(subscriberId)) {
    console.log('Skipping reply email — AI paused for subscriber:', subscriberId)
    return { sent: false, reason: 'ai_paused' }
  }

  // 1) AI-decided hand-off (replaces the old count-based trigger). If the
  //    classifier judges the founder is the better spend, hand off now and
  //    DO NOT send the AI follow-up this turn.
  if (classification.handoff) {
    console.log('AI decided hand-off on reply for subscriber:', subscriberId,
      '— recoveryLikelihood:', classification.recoveryLikelihood)
    await triggerFounderHandoff({
      subscriberId,
      classification,
      fromName,
      trigger: 'reply_classification',
    })
    return { sent: false, reason: 'ai_handoff' }
  }

  // 2) 3-email budget ceiling. Exit email + up to MAX_FOLLOWUPS follow-ups
  //    is the hard cap. If the AI has already burned both follow-up slots
  //    without deciding to hand off, silently close the subscriber as lost.
  //    Notably: NO founder email — the point of AI judgment is that if the
  //    AI never decided to escalate, the founder shouldn't be spammed either.
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
    console.log(`Budget exhausted for subscriber ${subscriberId} without hand-off — closing as lost`)
    await db
      .update(churnedSubscribers)
      .set({
        status:             'lost',
        handoffReasoning:   classification.handoffReasoning,
        recoveryLikelihood: classification.recoveryLikelihood,
        updatedAt:          new Date(),
      })
      .where(eq(churnedSubscribers.id, subscriberId))

    logEvent({
      name: 'subscriber_auto_lost',
      properties: {
        subscriberId,
        reason: 'budget_exhausted_no_handoff',
        recoveryLikelihood: classification.recoveryLikelihood,
        reasoningExcerpt:   classification.handoffReasoning.slice(0, 200),
      },
    })

    return { sent: false, reason: 'budget_exhausted' }
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

  // Persist the AI's per-pass judgment for observability, even though we
  // didn't hand off this turn. Lets the founder (and us) see the model's
  // ongoing reasoning when spot-auditing.
  await db
    .update(churnedSubscribers)
    .set({
      handoffReasoning:   classification.handoffReasoning,
      recoveryLikelihood: classification.recoveryLikelihood,
      updatedAt:          new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

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

  // Spec 22a — per-subscriber AI pause
  if (await isAiPaused(subscriberId)) {
    console.log('Skipping dunning email — AI paused for subscriber:', subscriberId)
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

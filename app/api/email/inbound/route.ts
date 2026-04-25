import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers, customers, users } from '@/lib/schema'
import { eq, count } from 'drizzle-orm'
import { Webhook } from 'svix'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { sendReplyEmail, resolveFounderNotificationEmail } from '@/src/winback/lib/email'
import { buildReplyAfterHandoffNotification } from '@/src/winback/lib/founder-handoff-email'
import { Resend } from 'resend'
import { SubscriberSignals } from '@/src/winback/lib/types'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Lazy-initialised Svix verifier. Per CLAUDE.md's serverless-safe rule, don't
 * read env vars at module load — read them inside the handler so missing-secret
 * doesn't crash the build.
 */
function getInboundVerifier(): Webhook | null {
  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) return null
  return new Webhook(secret)
}

/**
 * Pull the metadata out of Resend's `email.received` payload. The webhook
 * envelope wraps everything under `data`:
 *   { type: 'email.received', created_at, data: { email_id, from, to, subject } }
 *
 * IMPORTANT: the inbound webhook is metadata-only by design — Resend does
 * not include the body, headers, or attachments in the webhook payload.
 * To get the actual reply text we must fetch via the API
 * (GET /emails/receiving/{email_id}). See fetchInboundBody() below.
 */
type ResendInboundEnvelope = {
  email_id?: string
  to?: string | string[] | { email?: string } | Array<{ email?: string }>
  from?: string | { email?: string }
  text?: string                  // never present today, but kept defensively
  plain_text?: string            // legacy fallback
}

function extractEnvelope(body: unknown): {
  emailId: string
  to: string
  from: string
  text: string                    // empty in normal Resend webhooks
} {
  const wrapped = (body as { data?: ResendInboundEnvelope })?.data
  const src: ResendInboundEnvelope = (wrapped ?? body) as ResendInboundEnvelope

  const rawTo = Array.isArray(src.to) ? src.to[0] : src.to
  const to = typeof rawTo === 'string' ? rawTo : (rawTo?.email ?? '')
  const from = typeof src.from === 'string' ? src.from : (src.from?.email ?? '')
  const text = src.text ?? src.plain_text ?? ''
  const emailId = src.email_id ?? ''
  return { emailId, to, from, text }
}

/**
 * Fetch the actual body text of an inbound email from Resend's API.
 * Resend's webhook envelope is metadata-only; the body lives behind a
 * separate GET /emails/receiving/{id} call (per Resend docs).
 *
 * Returns the plain-text body, or empty string on failure (caller treats
 * empty as "skip this reply" gracefully).
 */
async function fetchInboundBody(emailId: string): Promise<string> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || !emailId) return ''
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      console.error('Resend /emails/receiving/<id> returned', res.status, await res.text())
      return ''
    }
    const json = (await res.json()) as { text?: string | null; html?: string | null }
    return json.text ?? ''
  } catch (err) {
    console.error('fetchInboundBody failed:', err)
    return ''
  }
}

export async function POST(req: Request) {
  // Read raw body up-front — Svix needs the unparsed string to verify HMAC.
  const rawBody = await req.text()

  // Verify the webhook signature. Without this, anyone could POST forged
  // "subscriber replies" and trigger AI re-classifications + founder
  // notifications. See specs/27 §observability for the broader pattern.
  const wh = getInboundVerifier()
  if (!wh) {
    console.error('Inbound webhook: RESEND_WEBHOOK_SECRET not set; rejecting')
    return NextResponse.json(
      { error: 'Webhook signing secret not configured' },
      { status: 503 },
    )
  }
  try {
    // svix expects a flat header object; req.headers is a Headers iterable.
    wh.verify(rawBody, Object.fromEntries(req.headers))
  } catch (err) {
    await logEvent({
      name: 'webhook_signature_invalid',
      properties: {
        source: 'resend_inbound',
        sourceIp: req.headers.get('x-forwarded-for') ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { emailId, to, from, text: envelopeText } = extractEnvelope(body)

  // Extract subscriberId from the "to" address: reply+{subscriberId}@<anyhost>.
  // Host doesn't matter for the parser — currently sent from
  // reply+<id>@reply.winbackflow.co (spec 27 / inbound subdomain).
  const match = to.match(/reply\+([a-f0-9-]+)@/i)
  if (!match) {
    console.log('Inbound email: no subscriber ID in to address:', to)
    return NextResponse.json({ received: true, processed: false, reason: 'no_subscriber_id' })
  }

  const subscriberId = match[1]
  console.log('Inbound reply for subscriber:', subscriberId, 'from:', from, 'email_id:', emailId)

  // Resend's email.received webhook is metadata-only — no body. Fetch the
  // actual reply text via /emails/receiving/{id}. Keep the envelope-text
  // fallback so a future webhook-shape change that DOES include body still
  // works without code change.
  const text = envelopeText || (emailId ? await fetchInboundBody(emailId) : '')

  // Strip quoted lines from reply
  const replyText = text
    .split('\n')
    .filter((line: string) => !line.trimStart().startsWith('>'))
    .join('\n')
    .trim()

  if (!replyText) {
    console.log('Empty reply text after stripping quotes (subscriberId:', subscriberId, 'emailId:', emailId, ')')
    return NextResponse.json({ received: true, processed: false, reason: 'empty_reply_text' })
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
    .set({
      replyText,
      lastEngagementAt: new Date(),  // Spec 21a — engagement signal
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  // Re-classify with reply text
  try {
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, subscriber.customerId))
      .limit(1)

    // Count emails already sent so the classifier can make a budget-aware
    // hand-off decision (cap is 3 = exit + up to 2 follow-ups).
    const [sentSoFar] = await db
      .select({ total: count() })
      .from(emailsSent)
      .where(eq(emailsSent.subscriberId, subscriberId))

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
      emailsSent: sentSoFar?.total ?? 0,
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
        handoffReasoning:   classification.handoffReasoning,
        recoveryLikelihood: classification.recoveryLikelihood,
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

    // Spec 22a — if subscriber is handed off OR has AI paused, route this reply
    // to the founder (not the AI). Notification rules:
    //   • Handed off + active pause (snooze) → muted (no notification)
    //   • Handed off + no active pause → notify (reply-after-handoff)
    //   • Proactive pause (not handed off) → notify (reply-during-pause)
    const isHandedOff = subscriber.founderHandoffAt && !subscriber.founderHandoffResolvedAt
    const isPaused = subscriber.aiPausedUntil && subscriber.aiPausedUntil.getTime() > Date.now()

    if (isHandedOff || isPaused) {
      // Handoff-snooze mutes notifications; any other combination notifies.
      const shouldNotify = !(isHandedOff && isPaused)

      if (!shouldNotify) {
        console.log('Reply received while handoff is snoozed — saved but no notification:', subscriberId)
      } else {
        try {
          const recipient = customer ? await resolveFounderNotificationEmail(customer.id) : null
          if (recipient) {
            const { subject, body } = await buildReplyAfterHandoffNotification({
              subscriber: {
                id: subscriber.id,
                email: subscriber.email,
                name: subscriber.name,
                planName: subscriber.planName,
                mrrCents: subscriber.mrrCents,
                cancellationReason: subscriber.cancellationReason,
                triggerNeed: subscriber.triggerNeed,
                cancelledAt: subscriber.cancelledAt,
                stripeComment: subscriber.stripeComment,
                replyText,
              },
              founderName: customer?.founderName ?? 'there',
              newReplyText: replyText,
            })
            const resend = new Resend(process.env.RESEND_API_KEY!)
            await resend.emails.send({
              from: `Winback <noreply@winbackflow.co>`,
              to: recipient,
              subject,
              text: body,
            })
            console.log('Reply-under-pause-or-handoff notification sent to founder:', recipient)
          }
        } catch (notifyErr) {
          console.error('Failed to notify founder of reply under pause/handoff:', notifyErr)
        }
      }
      // Don't auto-reply while under pause or handoff
      return NextResponse.json({ received: true, processed: true, handedOff: isHandedOff, paused: isPaused })
    }

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

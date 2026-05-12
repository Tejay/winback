import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers, customers, users, inboundEvents } from '@/lib/schema'
import { eq, count } from 'drizzle-orm'
import { Webhook } from 'svix'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { sendReplyEmail, resolveFounderNotificationEmail } from '@/src/winback/lib/email'
import { buildReplyAfterHandoffNotification } from '@/src/winback/lib/founder-handoff-email'
import { Resend } from 'resend'
import { SubscriberSignals } from '@/src/winback/lib/types'
import { logEvent } from '@/src/winback/lib/events'

type InboundOutcome =
  | 'processed'
  | 'no_subscriber_id'
  | 'subscriber_not_found'
  | 'empty_reply_text'

/**
 * Spec 64 — Reserve an idempotency token for an inbound webhook. INSERT
 * with ON CONFLICT DO NOTHING; if zero rows come back, this email_id has
 * been seen before and the caller must short-circuit.
 *
 * Returns true when this is the first time we've seen the id (caller
 * proceeds), false otherwise (caller returns `already_processed`).
 */
export async function reserveInboundEvent(emailId: string): Promise<boolean> {
  const reserved = await db
    .insert(inboundEvents)
    .values({ emailId, outcome: 'reserved' })
    .onConflictDoNothing()
    .returning({ emailId: inboundEvents.emailId })
  return reserved.length > 0
}

/**
 * Spec 64 — Finalize the reserved token with the terminal outcome. Called
 * at every exit point of the handler. No-op when emailId is empty (we
 * didn't reserve a row in that case).
 */
export async function finalizeInboundEvent(
  emailId: string,
  outcome: InboundOutcome,
  subscriberId?: string | null,
): Promise<void> {
  if (!emailId) return
  await db
    .update(inboundEvents)
    .set({ outcome, subscriberId: subscriberId ?? null })
    .where(eq(inboundEvents.emailId, emailId))
}

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

export function extractEnvelope(body: unknown): {
  emailId: string
  to: string
  from: string
  text: string                    // empty in normal Resend webhooks
} {
  const wrapped = (body as { data?: ResendInboundEnvelope })?.data
  // A literal JSON `null` body parses to `null` — coalesce to {} so we don't
  // crash on `src.to`. Without this, a malformed inbound 500s, Resend retries,
  // and we infinite-loop ourselves.
  const src: ResendInboundEnvelope = (wrapped ?? (body as ResendInboundEnvelope | null) ?? {}) as ResendInboundEnvelope

  const rawTo = Array.isArray(src.to) ? src.to[0] : src.to
  const to = typeof rawTo === 'string' ? rawTo : (rawTo?.email ?? '')
  const from = typeof src.from === 'string' ? src.from : (src.from?.email ?? '')
  const text = src.text ?? src.plain_text ?? ''
  const emailId = src.email_id ?? ''
  return { emailId, to, from, text }
}

/**
 * Parse the subscriber ID out of an inbound reply `to` address.
 *
 * We send win-back emails with `from: reply+<subscriberId>@reply.winbackflow.co`,
 * so the subscriber's reply lands at the same address. The subscriber ID is
 * the `+tag` portion. Host is intentionally ignored — only MX matters there.
 *
 * Returns the subscriber ID, or null if the address doesn't carry one.
 */
export function parseSubscriberIdFromTo(to: string): string | null {
  const match = to.match(/reply\+([a-f0-9-]+)@/i)
  return match ? match[1] : null
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

  // Spec 64 — idempotency gate. If Resend retries the same webhook (network
  // blip, our 500, etc.) we must not re-process: classifier costs money and
  // a second auto-reply would go out to the subscriber.
  if (!emailId) {
    // Resend always sends email_id per docs. A missing one means malformed
    // or non-Resend traffic — log it and fall through (can't dedup what we
    // can't identify).
    await logEvent({
      name: 'inbound_missing_email_id',
      properties: { source: 'resend_inbound' },
    })
  } else {
    const isFirst = await reserveInboundEvent(emailId)
    if (!isFirst) {
      console.log('Inbound webhook duplicate (email_id already processed):', emailId)
      return NextResponse.json({
        received: true,
        processed: false,
        reason: 'already_processed',
      })
    }
  }

  // Extract subscriberId from the "to" address: reply+{subscriberId}@<anyhost>.
  // Host doesn't matter for the parser — currently sent from
  // reply+<id>@reply.winbackflow.co (spec 27 / inbound subdomain).
  const subscriberId = parseSubscriberIdFromTo(to)
  if (!subscriberId) {
    console.log('Inbound email: no subscriber ID in to address:', to)
    await finalizeInboundEvent(emailId, 'no_subscriber_id')
    return NextResponse.json({ received: true, processed: false, reason: 'no_subscriber_id' })
  }
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
    await finalizeInboundEvent(emailId, 'empty_reply_text', subscriberId)
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
    await finalizeInboundEvent(emailId, 'subscriber_not_found', subscriberId)
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
      await finalizeInboundEvent(emailId, 'processed', subscriberId)
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

  await finalizeInboundEvent(emailId, 'processed', subscriberId)
  return NextResponse.json({ received: true, processed: true })
}

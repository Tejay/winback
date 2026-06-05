import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers, customers, inboundEvents, subscriberReplies } from '@/lib/schema'
import { eq, count, desc, and } from 'drizzle-orm'
import { Webhook } from 'svix'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { SubscriberSignals } from '@/src/winback/lib/types'
import { logEvent } from '@/src/winback/lib/events'
import { buildConversationThread } from '@/src/winback/lib/conversation'
import { deriveTriggerNeedConfidence } from '@/src/winback/lib/improvement-match'
import { stripQuotedReply } from '@/src/winback/lib/strip-quoted-reply'

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
 * Fetch the actual body text + threading headers of an inbound email
 * from Resend's API. The webhook envelope is metadata-only; the body and
 * headers live behind a separate GET /emails/receiving/{id} call.
 *
 * Returns { text, inReplyTo }. The `inReplyTo` is the RFC822 In-Reply-To
 * header (stripped of <>) — used to thread the reply to a specific
 * outbound (Spec 71). Returns empty strings on failure (caller treats
 * empty text as "skip this reply" gracefully).
 *
 * IMPORTANT: We never read attachments. `json.text` is plain-text only.
 */
async function fetchInboundBody(emailId: string): Promise<{ text: string; inReplyTo: string | null }> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || !emailId) return { text: '', inReplyTo: null }
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) {
      console.error('Resend /emails/receiving/<id> returned', res.status, await res.text())
      return { text: '', inReplyTo: null }
    }
    const json = (await res.json()) as {
      text?: string | null
      html?: string | null
      headers?: Record<string, string | string[]> | null
    }
    // Resend exposes RFC822 headers under `headers`. Different mail
    // clients use different casing — normalise.
    let inReplyTo: string | null = null
    if (json.headers) {
      for (const [k, v] of Object.entries(json.headers)) {
        if (k.toLowerCase() === 'in-reply-to') {
          const raw = Array.isArray(v) ? v[0] : v
          // Headers come wrapped in <...>; strip for matching.
          inReplyTo = String(raw ?? '').trim().replace(/^<|>$/g, '') || null
          break
        }
      }
    }
    return { text: json.text ?? '', inReplyTo }
  } catch (err) {
    console.error('fetchInboundBody failed:', err)
    return { text: '', inReplyTo: null }
  }
}

/** Spec 71 — cap per-reply storage at 20 KB. Truncate with marker. */
const MAX_REPLY_BODY_BYTES = 20 * 1024
function truncateReplyBody(body: string): string {
  if (body.length <= MAX_REPLY_BODY_BYTES) return body
  // 12 bytes for the truncation marker plus newline.
  return body.slice(0, MAX_REPLY_BODY_BYTES - 16) + '\n…[truncated]'
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

  // Resend delivers every subscribed event type to this one endpoint. Inbound
  // replies are 'email.received'; the deliverability events (email.bounced /
  // email.complained) are recorded here and acked — they carry no reply to
  // process, and they power the admin Now "Deliverability" line + the
  // spam-complaint red-light. Same webhook, same RESEND_WEBHOOK_SECRET, so no
  // separate endpoint or secret is needed.
  const eventType = (body as { type?: string } | null)?.type
  if (eventType === 'email.bounced' || eventType === 'email.complained') {
    const data = (body as { data?: Record<string, unknown> })?.data ?? {}
    await logEvent({
      name: eventType === 'email.bounced' ? 'email_bounced' : 'email_complained',
      properties: {
        emailId: (data.email_id as string) ?? null,
        to: Array.isArray(data.to) ? (data.to as string[]).join(', ') : ((data.to as string) ?? null),
        subject: (data.subject as string) ?? null,
        resendType: eventType,
      },
    })
    return NextResponse.json({ received: true })
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
  // actual reply text + In-Reply-To header via /emails/receiving/{id}.
  // Envelope-text path stays as fallback for any future webhook shape
  // that includes body inline.
  const fetched = emailId ? await fetchInboundBody(emailId) : { text: '', inReplyTo: null }
  const text = envelopeText || fetched.text
  const inReplyToHeader = fetched.inReplyTo

  // Strip quoted history, forwarded blocks, and signatures so we store only
  // what the subscriber actually typed (best-effort — clients quote
  // differently). We don't depend on this for thread reconstruction, which
  // uses our canonical wb_emails_sent + wb_subscriber_replies data via
  // buildConversationThread.
  const stripped = stripQuotedReply(text)

  if (!stripped) {
    console.log('Empty reply text after stripping quotes (subscriberId:', subscriberId, 'emailId:', emailId, ')')
    await finalizeInboundEvent(emailId, 'empty_reply_text', subscriberId)
    return NextResponse.json({ received: true, processed: false, reason: 'empty_reply_text' })
  }

  // Spec 71 — cap stored body at 20 KB to guard against DoS / pathological
  // pastes. Most legitimate replies are <2 KB.
  const replyBody = truncateReplyBody(stripped)

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

  // Spec 71 — match In-Reply-To header (when present) to a specific
  // outbound. The header references the original Message-ID; we stored
  // Resend's message ID in wb_emails_sent.gmail_message_id (legacy
  // column name — actually a Resend ID). Filter by subscriberId too so
  // a malicious payload can't thread to a different subscriber's email.
  let inReplyToEmailId: string | null = null
  if (inReplyToHeader) {
    const [match] = await db
      .select({ id: emailsSent.id })
      .from(emailsSent)
      .where(and(
        eq(emailsSent.gmailMessageId, inReplyToHeader),
        eq(emailsSent.subscriberId, subscriberId),
      ))
      .orderBy(desc(emailsSent.sentAt))
      .limit(1)
    inReplyToEmailId = match?.id ?? null
  }

  // Insert the reply row. ON CONFLICT (resend_email_id) DO NOTHING is the
  // second-layer dedup beyond Spec 64's wb_inbound_events.
  await db
    .insert(subscriberReplies)
    .values({
      subscriberId,
      body: replyBody,
      fromEmail: from || null,
      resendEmailId: emailId || null,
      inReplyToEmailId,
    })
    .onConflictDoNothing()

  // Mark `replied_at` on the matched outbound only. If threading didn't
  // resolve, leave timestamps alone — the new wb_subscriber_replies table
  // is the canonical record either way.
  if (inReplyToEmailId) {
    await db
      .update(emailsSent)
      .set({ repliedAt: new Date() })
      .where(eq(emailsSent.id, inReplyToEmailId))
  }

  await db
    .update(churnedSubscribers)
    .set({
      lastEngagementAt: new Date(),  // Spec 21a — engagement signal
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'email_replied',
    properties: {
      subscriberId,
      replyTextLength: replyBody.length,
      threadedToOutbound: !!inReplyToEmailId,
    },
  })

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
      // Spec 71 — thread the full back-and-forth into the classifier.
      // The reply we just inserted above is included via this builder.
      conversationThread: await buildConversationThread(subscriberId),
      billingPortalClicked: !!subscriber.billingPortalClickedAt,
      cancelledAt: subscriber.cancelledAt ?? new Date(),
      emailsSent: sentSoFar?.total ?? 0,
    }

    const classification = await classifySubscriber(signals, {
      founderName: customer?.founderName ?? undefined,
      productName: customer?.productName ?? undefined,
    })

    // Spec 72 — funnel transition. After a reply re-classifies the
    // subscriber, derive the new triggerNeedConfidence from the fresh
    // classification and persist it. This is the silent → has-signal
    // unlock: a previously low-confidence row whose reply now contains
    // a real reason flips to 'high', and V2 cron picks them up on the
    // next pass for re-engagement matching.
    // Drawer redesign — AI does NOT send follow-up emails. The reply is
    // re-classified purely to refresh the founder-facing analysis
    // (drawerInsight + recoveryLikelihood + triggerNeed). The AI's job is
    // to understand why they left and estimate recovery — not to keep
    // emailing. Any reply to the subscriber is the founder's, via the
    // take-over composer.
    //
    // Why no AI follow-up: every commitment/false-promise the classifier
    // produced in testing happened in follow-ups, where "ask one more
    // question" runs out of road and the LLM fills the vacuum with
    // invented offers. Exit emails are bounded and clean; follow-ups
    // aren't. So we removed them.
    await db
      .update(churnedSubscribers)
      .set({
        tier: classification.tier,
        confidence: String(classification.confidence),
        triggerKeyword: classification.triggerKeyword,
        triggerNeed: classification.triggerNeed,
        triggerNeedConfidence: deriveTriggerNeedConfidence(classification),
        cancellationReason: classification.cancellationReason,
        cancellationCategory: classification.cancellationCategory,
        drawerInsightRead:         classification.drawerInsight?.read ?? '',
        drawerInsightWorthKnowing: classification.drawerInsight?.worthKnowing ?? '',
        recoveryLikelihood: classification.recoveryLikelihood,
        updatedAt: new Date(),
      })
      .where(eq(churnedSubscribers.id, subscriberId))

    console.log('Re-classified subscriber after reply (analysis only, no auto-reply):', subscriberId, 'tier:', classification.tier, 'recovery:', classification.recoveryLikelihood)
  } catch (err) {
    console.error('Re-classification after reply failed:', err)
  }

  await finalizeInboundEvent(emailId, 'processed', subscriberId)
  return NextResponse.json({ received: true, processed: true })
}

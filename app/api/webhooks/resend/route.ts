import { NextResponse } from 'next/server'
import { Webhook } from 'svix'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Resend delivery-events webhook — the deliverability signal.
 *
 * Receives Resend's `email.*` notifications and records the two that mean
 * the product is silently breaking on the delivery side:
 *   - email.bounced    → email_bounced     (sending to dead addresses)
 *   - email.complained → email_complained  (spam complaint — reputation risk;
 *                        a rising complaint rate gets the domain throttled/
 *                        blocked, which kills ALL delivery with no app error)
 * Every other type (delivered/sent/opened/clicked/delivery_delayed) is
 * acknowledged and ignored.
 *
 * This is SEPARATE from /api/email/inbound (that's Resend Inbound — subscriber
 * replies). Configure a Resend *Webhook* (Events) pointing here, subscribe it
 * to email.bounced + email.complained, and set RESEND_DELIVERY_WEBHOOK_SECRET
 * to that endpoint's signing secret.
 *
 * Signature: svix, mirroring the inbound route. Serverless-safe — read the
 * secret inside the handler so a missing secret never crashes the build.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const secret = process.env.RESEND_DELIVERY_WEBHOOK_SECRET
  if (!secret) {
    console.error('Resend events webhook: RESEND_DELIVERY_WEBHOOK_SECRET not set; rejecting')
    return NextResponse.json({ error: 'Webhook signing secret not configured' }, { status: 503 })
  }

  const rawBody = await req.text()
  let event: { type?: string; data?: Record<string, unknown> }
  try {
    event = new Webhook(secret).verify(rawBody, Object.fromEntries(req.headers)) as typeof event
  } catch (err) {
    await logEvent({
      name: 'webhook_signature_invalid',
      properties: {
        source: 'resend_events',
        sourceIp: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    }).catch(() => {})
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const type = String(event?.type ?? '')
  const data = event?.data ?? {}
  // Field shapes beyond `type` vary by event; keep extraction best-effort and
  // store the raw type for triage. `to` is an array on Resend events.
  const props = {
    emailId: (data.email_id as string) ?? null,
    to: Array.isArray(data.to) ? (data.to as string[]).join(', ') : ((data.to as string) ?? null),
    subject: (data.subject as string) ?? null,
    resendType: type,
  }

  if (type === 'email.bounced') {
    await logEvent({ name: 'email_bounced', properties: props })
  } else if (type === 'email.complained') {
    await logEvent({ name: 'email_complained', properties: props })
  }

  // Always 2xx so Resend stops retrying (including for the ignored types).
  return NextResponse.json({ received: true })
}

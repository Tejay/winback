import { Resend } from 'resend'
import { resolveFounderNotificationEmail } from './email'
import { createHmac } from 'crypto'

/**
 * Sends the founder a notice that their platform $99/mo charge failed.
 *
 * Stripe's Smart Retries will retry the charge automatically over the
 * next 1–3 weeks. This email is a heads-up so the customer can update
 * their card before retries are exhausted and the subscription becomes
 * `unpaid` (which would pause win-back fee billing too).
 *
 * Best-effort: if RESEND_API_KEY isn't set or there's no notification
 * email on file, the function logs and returns silently. The webhook
 * handler shouldn't fail just because the heads-up didn't go out.
 */
export async function sendPlatformPaymentFailedEmail(params: {
  customerId: string
  invoiceAmountCents: number
  hostedInvoiceUrl: string | null
}): Promise<void> {
  const { customerId, invoiceAmountCents, hostedInvoiceUrl } = params

  const to = await resolveFounderNotificationEmail(customerId)
  if (!to) {
    console.warn('[billing-notifications] no notification email for', customerId)
    return
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[billing-notifications] RESEND_API_KEY not set — skipping email')
    return
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
  const amount = `$${(invoiceAmountCents / 100).toFixed(2)}`
  const settingsUrl = `${appUrl}/settings#billing`

  const text = [
    `Your Winback platform payment of ${amount} failed.`,
    '',
    `Stripe will retry the charge automatically over the next few days.`,
    `To avoid an interruption to your card-save and win-back automation,`,
    `please update your payment method:`,
    '',
    `  ${settingsUrl}`,
    '',
    hostedInvoiceUrl ? `Invoice details: ${hostedInvoiceUrl}` : '',
    '',
    `If retries fail, your subscription will be paused and recoveries will`,
    `stop until you update the card.`,
    '',
    `— Winback`,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join('\n')

  try {
    const resend = new Resend(apiKey)
    await resend.emails.send({
      from: 'Winback Billing <noreply@winbackflow.co>',
      to,
      subject: `Action needed: Winback payment failed (${amount})`,
      text,
    })
  } catch (err) {
    console.error('[billing-notifications] failed to send', customerId, err)
  }
}

// ───────────────────────────────────────────────────────────────────────
// Spec 51 — post-first-recovery email flow
// Four senders, all best-effort (no thrown errors), all share the same
// "subscribe link" + "opt-out link" pattern.
// ───────────────────────────────────────────────────────────────────────

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
}

function subscribeUrl(): string {
  return `${appUrl()}/dashboard?subscribe=1`
}

/**
 * Spec 51 — signed token for the unsubscribe link in monthly reports.
 * Same HMAC pattern as the subscriber unsubscribe URL. Used by
 * /api/billing/opt-out to authenticate the click before flipping
 * billingEmailsOptedOutAt on the customer row.
 */
export function billingOptOutToken(customerId: string): string {
  const secret = process.env.NEXTAUTH_SECRET ?? ''
  if (!secret) {
    // Fail loud rather than silently issue invalid tokens — but only
    // throw at call time (per CLAUDE.md serverless-safe init rule).
    throw new Error('NEXTAUTH_SECRET not set; cannot generate opt-out token')
  }
  return createHmac('sha256', secret).update(`billing-opt-out:${customerId}`).digest('hex')
}

export function billingOptOutUrl(customerId: string): string {
  return `${appUrl()}/api/billing/opt-out?customer=${customerId}&t=${billingOptOutToken(customerId)}`
}

async function sendBillingEmail(params: {
  to: string
  subject: string
  text: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[billing-notifications] RESEND_API_KEY not set — skipping email')
    return
  }
  try {
    const resend = new Resend(apiKey)
    await resend.emails.send({
      from: 'Winback <noreply@winbackflow.co>',
      to: params.to,
      subject: params.subject,
      text: params.text,
    })
  } catch (err) {
    console.error('[billing-notifications] failed to send', err)
  }
}

/**
 * Spec 51 — sent ONCE when the first recovery delivers and activatedAt
 * is set. Announces the new "paused until you subscribe" rules.
 */
export async function sendPlatformTrialCompleteEmail(params: {
  customerId: string
  recoveredSubscriberName: string | null
  recoveredMrrCents: number
}): Promise<void> {
  const { customerId, recoveredSubscriberName, recoveredMrrCents } = params
  const to = await resolveFounderNotificationEmail(customerId)
  if (!to) {
    console.warn('[billing-notifications] no notification email for trial-complete:', customerId)
    return
  }
  const who = recoveredSubscriberName ?? 'Your first subscriber'
  const mrr = `$${(recoveredMrrCents / 100).toFixed(2)}/mo`
  const text = [
    `Your first recovery just delivered — ${who} is back at ${mrr}.`,
    '',
    `Going forward, Winback is paused until you subscribe:`,
    `  · No more win-back emails will be sent`,
    `  · No more payment recovery emails will be sent`,
    `  · You can still see all cancellations + failed payments in your dashboard`,
    '',
    `Subscribe to resume:`,
    `  ${subscribeUrl()}`,
    '',
    `Or disconnect Stripe from /settings if Winback isn't right for you.`,
    '',
    `— The Winback team`,
  ].join('\n')
  await sendBillingEmail({
    to,
    subject: `🎉 ${who} is back — trial complete`,
    text,
  })
}

/**
 * Spec 51 — sent ONCE, 7 days after activatedAt if the customer hasn't
 * subscribed. Cron-driven, idempotent via billingNudgeDay7SentAt.
 */
export async function sendBillingNudgeDay7Email(params: {
  customerId: string
  cancellationsSincePauseCount: number
  failedPaymentsSincePauseCount: number
}): Promise<void> {
  const { customerId, cancellationsSincePauseCount, failedPaymentsSincePauseCount } = params
  const to = await resolveFounderNotificationEmail(customerId)
  if (!to) {
    console.warn('[billing-notifications] no notification email for day-7 nudge:', customerId)
    return
  }
  const text = [
    `Hey,`,
    '',
    `You paused Winback a week ago. Since then:`,
    `  · ${cancellationsSincePauseCount} cancellation${cancellationsSincePauseCount === 1 ? '' : 's'}`,
    `  · ${failedPaymentsSincePauseCount} failed payment${failedPaymentsSincePauseCount === 1 ? '' : 's'}`,
    `slipped past without recovery attempts.`,
    '',
    `Resume:`,
    `  ${subscribeUrl()}`,
    '',
    `If Winback isn't right for you, disconnect Stripe via /settings.`,
  ].join('\n')
  await sendBillingEmail({
    to,
    subject: `Quick check-in on your Winback account`,
    text,
  })
}

/**
 * Spec 51 — sent ONCE, 30 days after activatedAt if still no subscription.
 * Cron-driven, idempotent via billingNudgeDay30SentAt.
 */
export async function sendBillingNudgeDay30Email(params: {
  customerId: string
}): Promise<void> {
  const { customerId } = params
  const to = await resolveFounderNotificationEmail(customerId)
  if (!to) {
    console.warn('[billing-notifications] no notification email for day-30 nudge:', customerId)
    return
  }
  const text = [
    `Hey,`,
    '',
    `You've been paused for a month. Resume any time:`,
    `  ${subscribeUrl()}`,
    '',
    `Or if Winback isn't the right fit, disconnect via /settings — clean exit, no charges.`,
    '',
    `(If something specific kept you from using Winback, hit reply — would genuinely want to know.)`,
  ].join('\n')
  await sendBillingEmail({
    to,
    subject: `Still paused — anything we can fix?`,
    text,
  })
}

/**
 * Spec 51 — monthly churn report, sent every 28 days after the day-30
 * nudge, until subscribe / disconnect / opt-out. Cadence-based via
 * billingMonthlyReportLastSentAt.
 */
export async function sendBillingMonthlyReportEmail(params: {
  customerId: string
  monthLabel: string  // e.g. "June"
  cancellationsCount: number
  failedPaymentsCount: number
  recoverableCount: number
  recoverableMrrAnnualizedCents: number
}): Promise<void> {
  const {
    customerId,
    monthLabel,
    cancellationsCount,
    failedPaymentsCount,
    recoverableCount,
    recoverableMrrAnnualizedCents,
  } = params
  const to = await resolveFounderNotificationEmail(customerId)
  if (!to) {
    console.warn('[billing-notifications] no notification email for monthly report:', customerId)
    return
  }
  const annualized = `$${Math.round(recoverableMrrAnnualizedCents / 100).toLocaleString()}/yr`
  const text = [
    `Hey,`,
    '',
    `Here's what happened on your Winback account in ${monthLabel}:`,
    '',
    `  · ${cancellationsCount} cancellation${cancellationsCount === 1 ? '' : 's'}`,
    `  · ${failedPaymentsCount} failed payment${failedPaymentsCount === 1 ? '' : 's'}`,
    `  · ${recoverableCount} subscriber${recoverableCount === 1 ? '' : 's'} classified as recoverable`,
    `  · ~${annualized} in MRR that Winback would have worked`,
    '',
    `Resume:`,
    `  ${subscribeUrl()}`,
    '',
    `Don't want these monthly reports? Unsubscribe:`,
    `  ${billingOptOutUrl(customerId)}`,
  ].join('\n')
  await sendBillingEmail({
    to,
    subject: `Your ${monthLabel} churn report`,
    text,
  })
}

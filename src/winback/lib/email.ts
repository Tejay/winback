import { Resend } from 'resend'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers, customers, users } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { ClassificationResult } from './types'
import { generateUnsubscribeToken } from './unsubscribe-token'
import { logEvent } from './events'
import { callWithRetry } from './retry'
import {
  renderDunningEmailHtml,
  renderWinbackEmailHtml,
  renderPasswordResetHtml,
  renderVerificationEmailHtml,
  renderOnboardingNudgeHtml,
  renderDormantWarningHtml,
  renderPilotEndingHtml,
} from './email-html'
import { declineCodeToCopy, DeclineCopy } from './decline-codes'
import { isCustomerBillingHealthy_BySubscriber } from './billing-enforcement'

/**
 * Spec 28 — Postgres unique-violation error code. The partial unique index
 * on `wb_emails_sent (subscriber_id, type)` raises this when a webhook
 * redelivery races past the find-or-resend check. We treat it as success
 * (the previous send committed first; the email DID go out).
 *
 * Newer drizzle-orm wraps the raw pg error inside a `DrizzleQueryError`
 * for richer logging — the `'23505'` code lives on `.cause.code` rather
 * than `.code` directly. We check both shapes so an idempotency catch
 * works regardless of which version is in node_modules.
 */
const PG_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(err: unknown): boolean {
  type WithCode = { code?: string; cause?: WithCode }
  const e = err as WithCode | null
  return e?.code === PG_UNIQUE_VIOLATION || e?.cause?.code === PG_UNIQUE_VIOLATION
}

export async function recordEmailSentIdempotent(
  values: typeof emailsSent.$inferInsert,
  ctx: string,
): Promise<void> {
  try {
    await db.insert(emailsSent).values(values)
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.log(`[${ctx}] duplicate (subscriber_id, type) — already sent, treating as success`)
      return
    }
    throw err
  }
}

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

/**
 * The "From" display name shown in Gmail's sender column when a
 * subscriber receives a win-back or dunning email. Combines founder +
 * product when both are present so the recipient gets brand
 * recognition before opening the email.
 *
 * Resolution order:
 *   founder && product → "{founder} from {product}"
 *   founder only       → "{founder}"
 *   product only       → "{product}"
 *   neither            → "The team"  (or `fallback` if supplied)
 *
 * Used by every subscriber-facing send path so the inbox-line
 * branding stays consistent across exit, follow-up, improvement-match,
 * promotion, and dunning emails.
 */
export function buildFromDisplayName(opts: {
  founderName?: string | null
  productName?: string | null
  fallback?:    string
}): string {
  const founder = opts.founderName?.trim()
  const product = opts.productName?.trim()
  if (founder && product) return `${founder} from ${product}`
  return founder || product || opts.fallback || 'The team'
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
  // NOTE: the sign-off ("— Name") is NOT added here anymore. It belongs to
  // the body, guaranteed by ensureSignoff() before this runs — so it renders
  // consistently in BOTH the text (this) and HTML (renderWinbackEmailHtml,
  // which takes the raw body) paths. This footer only adds the resubscribe
  // CTA + unsubscribe line.
  return `${body}

Ready to give us another try? Resubscribe here:
${reactivationUrl(subscriberId)}

— — —
If you'd rather not hear from us, unsubscribe: ${unsubscribeUrl(subscriberId)}`
}

/**
 * Guarantees a body ends with exactly one sign-off line ("— {fromName}").
 *
 * Append-if-missing, never strip: if the body already ends with a sign-off
 * (em-dash / en-dash / hyphen + a word), it's left untouched — this respects
 * a founder's hand-typed closing on the take-over reply path. Only when no
 * sign-off is present do we append the canonical one.
 *
 * Why this exists: the sign-off used to be split across three owners (the
 * LLM prompt asked for it, appendStandardFooter added another, the HTML
 * renderer added none). Result: ~76% of AI exit emails shipped with no
 * sign-off in HTML, and the rare LLM-signed ones double-signed in text.
 * Now code owns it, in one place, before both render paths.
 */
export function ensureSignoff(body: string, fromName: string): string {
  const trimmed = body.trimEnd()
  // Already ends with a sign-off line? (e.g. "\n— Alex", "\n– Sam", "\n- Jo")
  if (/\n\s*[—–-]\s*\S.*$/.test(trimmed)) return trimmed
  return `${trimmed}\n\n— ${fromName}`
}

/**
 * Strips the standard footer (reactivation block, sign-off separator,
 * unsubscribe link) from a stored body so the dashboard can render the
 * conversation without boilerplate or signed URLs. Truncates at the first
 * marker that appears — handles both the win-back footer (starts with
 * "Ready to give us another try?") and the dunning footer (starts with the
 * "— — —" separator before the unsubscribe line).
 */
export function stripStandardFooter(body: string): string {
  const markers = [
    'Ready to give us another try? Resubscribe here:',
    '\n— — —',
    "If you'd rather not hear from us, unsubscribe:",
  ]
  let cut = body.length
  for (const m of markers) {
    const i = body.indexOf(m)
    if (i !== -1 && i < cut) cut = i
  }
  return body.slice(0, cut).trimEnd()
}

/**
 * Returns true if the subscriber has opted out. Callers must skip sending.
 */
export async function isDoNotContact(subscriberId: string): Promise<boolean> {
  const [row] = await db
    .select({ dnc: churnedSubscribers.doNotContact })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  return row?.dnc ?? false
}

/**
 * Spec 55 — true if the customer paused the WIN-BACK cohort
 * (exit emails, reply win-backs, reengagement nudges) via Settings.
 *
 * Reads `customers.paused_at` — semantically narrowed to win-back
 * only as of spec 55. Payment-recovery emails check
 * `isCustomerPausedForDunning` instead.
 */
export async function isCustomerPausedForWinback(subscriberId: string): Promise<boolean> {
  const [row] = await db
    .select({ pausedAt: customers.pausedAt })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  return !!row?.pausedAt
}

/**
 * Spec 55 — true if the customer paused the PAYMENT-RECOVERY cohort
 * (dunning + dunning followup) via Settings.
 *
 * Reads `customers.paused_dunning_at`. Independent of the win-back
 * pause — merchants can pause one without the other.
 */
export async function isCustomerPausedForDunning(subscriberId: string): Promise<boolean> {
  const [row] = await db
    .select({ pausedDunningAt: customers.pausedDunningAt })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  return !!row?.pausedDunningAt
}

/**
 * Legacy combined helper — true if either cohort is paused. Kept as a
 * thin OR-wrapper for any caller I missed during the spec 55 split.
 * No active senders use this directly anymore.
 *
 * @deprecated since spec 55. Prefer `isCustomerPausedForWinback` or
 * `isCustomerPausedForDunning` depending on the email cohort.
 */
export async function isCustomerPausedForSubscriber(subscriberId: string): Promise<boolean> {
  return (
    (await isCustomerPausedForWinback(subscriberId)) ||
    (await isCustomerPausedForDunning(subscriberId))
  )
}

/**
 * Spec 51 — Returns true when the customer is in post-trial paused state:
 * first recovery delivered (activatedAt set) AND no active platform
 * subscription. Callers must skip sending win-back / payment-recovery
 * emails. Pause is implicit — there's no "unpause" button; the merchant
 * subscribes to resume.
 *
 * Pilot bypass: pilot customers (pilotUntil > now) are NOT considered
 * paused — pilot is its own free tier per spec 31.
 */
export async function isCustomerPausedForBilling(subscriberId: string): Promise<boolean> {
  const [row] = await db
    .select({
      activatedAt: customers.activatedAt,
      stripeSubscriptionId: customers.stripeSubscriptionId,
      pilotUntil: customers.pilotUntil,
    })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  if (!row) return false
  if (row.pilotUntil && row.pilotUntil.getTime() > Date.now()) return false
  return !!row.activatedAt && !row.stripeSubscriptionId
}

/**
 * Spec 53 — same predicate as isCustomerPausedForBilling but keyed by
 * wb_customer id, not subscriber id. Used by the reengagement cron to
 * pre-filter paused customers at batch level so we don't spend on LLM
 * classification calls we'll then skip at send time. Single SELECT,
 * no JOIN.
 */
export async function isCustomerPausedForBillingByCustomerId(customerId: string): Promise<boolean> {
  const [row] = await db
    .select({
      activatedAt: customers.activatedAt,
      stripeSubscriptionId: customers.stripeSubscriptionId,
      pilotUntil: customers.pilotUntil,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)
  if (!row) return false
  if (row.pilotUntil && row.pilotUntil.getTime() > Date.now()) return false
  return !!row.activatedAt && !row.stripeSubscriptionId
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

  // Use reply+{subscriberId}@reply.winbackflow.co so subscriber replies route
  // to Resend Inbound (root MX still points at Neo for tejay@winbackflow.co
  // etc.). The inbound webhook regex parses the prefix only, so the host
  // doesn't matter as long as MX is set up. See spec 27 + inbound DNS plan.
  const from = `${fromName} <reply+${subscriberId}@reply.winbackflow.co>`

  // Sign-off is code-owned: ensure exactly one in the body BEFORE rendering
  // so text + HTML stay consistent. See ensureSignoff().
  const signedBody = ensureSignoff(body, fromName)
  const fullBody = appendStandardFooter(signedBody, subscriberId, fromName)
  const html     = renderWinbackEmailHtml({
    body: signedBody,
    reactivationUrl: reactivationUrl(subscriberId),
    unsubscribeUrl:  unsubscribeUrl(subscriberId),
  })

  // Spec 28 — wrap the Resend send so transient 429s are absorbed inside
  // the function call rather than bubbling up as webhook 5xxs.
  const res = await callWithRetry(
    () =>
      resend.emails.send({
        from,
        to,
        subject,
        text: fullBody,
        html,
        headers: listUnsubscribeHeaders(subscriberId),
      }),
    { ctx: 'sendEmail' },
  )

  if (res.error) {
    // Spec 26 — emit BEFORE re-throwing so the row lands even when the
    // surrounding handler converts the error to a 500.
    await logEvent({
      name: 'email_send_failed',
      properties: {
        subscriberId,
        type: 'sendEmail',
        errorMessage: res.error.message,
      },
    })
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

  // Spec 55 — win-back cohort pause
  if (await isCustomerPausedForWinback(subscriberId)) {
    console.log('Skipping exit email — customer has paused win-back sending:', subscriberId)
    return
  }

  // Spec 51 — post-trial billing pause (auto-paused after first delivered
  // recovery until subscription is active).
  if (await isCustomerPausedForBilling(subscriberId)) {
    console.log('Skipping exit email — customer in post-trial billing pause:', subscriberId)
    await logEvent({
      name: 'send_skipped_billing_pause',
      properties: { subscriberId, emailType: 'exit' },
    })
    return
  }

  // 2026-05-18 — billing-health gate: skip if the merchant's Stripe
  // sub is in a non-paying state (incomplete_expired / canceled /
  // unpaid / paused). Stops Anthropic + Resend spend on freeloaders.
  // Different from the above checks — this looks at LIVE Stripe sub
  // status, not DB-cached pause flags. See billing-enforcement.ts.
  if (!(await isCustomerBillingHealthy_BySubscriber(subscriberId))) {
    console.log('Skipping exit email — merchant billing unhealthy:', subscriberId)
    await logEvent({
      name: 'send_skipped_billing_unhealthy',
      properties: { subscriberId, emailType: 'exit' },
    })
    return
  }

  // Spec 22a — per-subscriber AI pause
  if (await isAiPaused(subscriberId)) {
    console.log('Skipping exit email — AI paused for subscriber:', subscriberId)
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

  // Spec 27 — persist the full body so /admin/subscribers/[id] can render
  // the conversation turn-by-turn. Sign + footer it so the stored copy
  // matches exactly what sendEmail() actually sent (which signs the body).
  const fullBody = appendStandardFooter(ensureSignoff(body, fromName), subscriberId, fromName)
  // Spec 28 — idempotent on (subscriber_id, type) per migration 023.
  await recordEmailSentIdempotent(
    {
      subscriberId,
      gmailMessageId: messageId,
      type: 'exit',
      subject,
      bodyText: fullBody,
    },
    'scheduleExitEmail',
  )

  await db
    .update(churnedSubscribers)
    .set({ status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'email_sent',
    properties: { subscriberId, emailType: 'exit', subject, messageId },
  })
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

  // Spec 55 — payment-recovery cohort pause. Was missing entirely
  // before spec 55 (only the followup variant was gated). Closed
  // when we split pause control into win-back + dunning cohorts.
  if (await isCustomerPausedForDunning(subscriberId)) {
    console.log('Skipping dunning email — customer has paused dunning:', subscriberId)
    return
  }

  // 2026-05-18 — billing-health gate (see sendEmail for context).
  // Applies to payment-recovery emails too: a merchant who isn't
  // paying us shouldn't get Winback running their dunning sequence.
  if (!(await isCustomerBillingHealthy_BySubscriber(subscriberId))) {
    console.log('Skipping dunning email — merchant billing unhealthy:', subscriberId)
    await logEvent({
      name: 'send_skipped_billing_unhealthy',
      properties: { subscriberId, emailType: 'dunning' },
    })
    return
  }

  // Spec 51 — post-trial billing pause
  if (await isCustomerPausedForBilling(subscriberId)) {
    console.log('Skipping dunning email — customer in post-trial billing pause:', subscriberId)
    await logEvent({
      name: 'send_skipped_billing_pause',
      properties: { subscriberId, emailType: 'dunning' },
    })
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

  // Spec 34 — pull the latest decline code from the subscriber row and
  // resolve bespoke reason + action copy. NULL maps to the fallback
  // bucket which preserves today's generic wording.
  const [declineRow] = await db
    .select({ lastDeclineCode: churnedSubscribers.lastDeclineCode })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  const declineCopy: DeclineCopy = declineCodeToCopy(declineRow?.lastDeclineCode)

  let subject: string
  let body: string
  let retryDateStr: string | null = null
  // Spec 34 — temporary/Stripe-side declines suppress the update CTA;
  // we don't want to push the customer to act when Stripe is at fault.
  const updateBlockText = declineCopy.suppressUpdateCta
    ? ''
    : `\nUpdate your payment method here:\n${updateLink}\n`

  if (nextRetryDate) {
    retryDateStr = nextRetryDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    subject = 'Your payment didn\'t go through'
    body = `Hi ${name},

We tried to charge your card for ${planName} (${amount} ${currency.toUpperCase()}) but it didn't go through.

Why this happened: ${declineCopy.reason}

Best next step: ${declineCopy.action}
${updateBlockText}
We'll try again on ${retryDateStr} — updating before then means no interruption to your service.

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

  // Spec 37 — HTML body sent alongside text. Resend wraps both into a
  // multipart/alternative envelope; the recipient's client picks
  // whichever it prefers. The text body above is the canonical fallback.
  // Spec 34 — pass the resolved decline copy so HTML renders the same
  // bespoke reason / action lines (and respects suppressUpdateCta).
  const html = renderDunningEmailHtml({
    customerName,
    planName,
    amount,
    currency,
    retryDateStr,
    updateLink,
    unsubLink,
    fromName,
    isFinalRetry: !nextRetryDate,
    declineCopy,
  })

  // Spec 28 — wrap the Resend call in callWithRetry.
  const res = await callWithRetry(
    () =>
      resend.emails.send({
        from,
        to: email,
        subject,
        text: body,
        html,
        headers: listUnsubscribeHeaders(subscriberId),
      }),
    { ctx: 'sendDunning' },
  )

  if (res.error) {
    // Spec 26 — observability: emit BEFORE re-throwing.
    await logEvent({
      name: 'email_send_failed',
      properties: {
        subscriberId,
        type: 'dunning',
        errorMessage: res.error.message,
      },
    })
    throw new Error(`Resend error: ${res.error.message}`)
  }

  // Spec 28 — idempotent on (subscriber_id, type) per migration 023.
  await recordEmailSentIdempotent(
    {
      subscriberId,
      gmailMessageId: res.data?.id ?? '',
      type: 'dunning',
      subject,
      bodyText: body,  // spec 27 — Inspector renders this
    },
    'sendDunning',
  )

  await db
    .update(churnedSubscribers)
    .set({ status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'email_sent',
    properties: { subscriberId, emailType: 'dunning', subject, messageId: res.data?.id ?? '' },
  })
}

/**
 * Spec 33 — Multi-touch dunning T2 / T3.
 *
 * Sent ~24h before Stripe's next retry attempt by /api/cron/dunning-followup.
 * The same function covers both touches; copy is switched by `isFinalRetry`.
 *
 *   T2 (`isFinalRetry: false`) — "Stripe will retry on {date}, update before then"
 *   T3 (`isFinalRetry: true`)  — "Last automatic retry — your subscription ends"
 *
 * Idempotent at-most-once delivery via the partial unique index on
 * wb_emails_sent (subscriber_id, type) — extended in migration 028 to cover
 * 'dunning_t2' and 'dunning_t3'.
 */
export async function sendDunningFollowupEmail(params: {
  subscriberId: string
  email: string
  customerName: string | null
  planName: string
  amountDue: number
  currency: string
  retryDate: Date
  fromName: string
  isFinalRetry: boolean
}): Promise<void> {
  const {
    subscriberId, email, customerName, planName, amountDue, currency,
    retryDate, fromName, isFinalRetry,
  } = params

  // Same suppression gates as the existing dunning email.
  if (await isDoNotContact(subscriberId)) {
    console.log('Skipping dunning followup — DNC:', subscriberId)
    return
  }
  // Spec 55 — payment-recovery cohort pause
  if (await isCustomerPausedForDunning(subscriberId)) {
    console.log('Skipping dunning followup — customer has paused dunning:', subscriberId)
    return
  }
  // Spec 51 — post-trial billing pause
  if (await isCustomerPausedForBilling(subscriberId)) {
    console.log('Skipping dunning followup — post-trial billing pause:', subscriberId)
    await logEvent({
      name: 'send_skipped_billing_pause',
      properties: { subscriberId, emailType: 'dunning_followup' },
    })
    return
  }

  // 2026-05-18 — billing-health gate (see sendEmail for context).
  if (!(await isCustomerBillingHealthy_BySubscriber(subscriberId))) {
    console.log('Skipping dunning followup — merchant billing unhealthy:', subscriberId)
    await logEvent({
      name: 'send_skipped_billing_unhealthy',
      properties: { subscriberId, emailType: 'dunning_followup' },
    })
    return
  }
  if (await isAiPaused(subscriberId)) {
    console.log('Skipping dunning followup — AI paused:', subscriberId)
    return
  }

  const resend = getResendClient()
  const name = customerName ?? 'there'
  const amount = (amountDue / 100).toFixed(2)
  const updateLink = `${process.env.NEXT_PUBLIC_APP_URL}/api/update-payment/${subscriberId}`
  const unsubLink = unsubscribeUrl(subscriberId)
  const from = `${fromName} <noreply@winbackflow.co>`

  // Spec 34 — read the latest decline code captured by the webhook
  // and resolve bespoke copy. T2/T3 inherit whatever the most recent
  // payment_failed event told us; if the bank's reason changed across
  // retries we always use the latest.
  const [declineRow] = await db
    .select({ lastDeclineCode: churnedSubscribers.lastDeclineCode })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  const declineCopy: DeclineCopy = declineCodeToCopy(declineRow?.lastDeclineCode)

  // Format retry date + time. We mirror the existing dunning email's
  // dd-LL formatting plus a UTC time so the customer can convert.
  const retryDateStr = retryDate.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long',
  })
  const retryTimeStr = retryDate.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + ' UTC'

  const type: 'dunning_t2' | 'dunning_t3' = isFinalRetry ? 'dunning_t3' : 'dunning_t2'

  const subject = isFinalRetry
    ? `Last automatic retry — your subscription ends ${retryDateStr}`
    : `Heads up — we'll retry your card on ${retryDateStr}`

  // Spec 34 — bespoke "why this happened" + "best next step" lines.
  // suppressUpdateCta hides the update link in the body too (text + html).
  const updateBlockText = declineCopy.suppressUpdateCta
    ? ''
    : `\nUpdate your payment method here:\n${updateLink}\n`

  const body = isFinalRetry
    ? `Hi ${name},

This is your last chance to update your payment before your subscription
with ${fromName} ends.

Why this happened: ${declineCopy.reason}

Best next step: ${declineCopy.action}

We'll try your card one final time on ${retryDateStr} at ${retryTimeStr}.
If it fails, your subscription will be cancelled and you'll lose access
to ${planName}.
${updateBlockText}
If you've decided to leave, no need to reply — your subscription will
cancel on its own.

— ${fromName}

— — —
If you'd rather not hear from us, unsubscribe: ${unsubLink}`
    : `Hi ${name},

Quick reminder: your last payment to ${fromName} for ${planName} (${amount} ${currency.toUpperCase()}) didn't go through, and we'll automatically try your card again on ${retryDateStr} at ${retryTimeStr}.

Why this happened: ${declineCopy.reason}

Best next step: ${declineCopy.action}
${updateBlockText}
If everything's already sorted, you can ignore this email — the next
retry will go through automatically.

— ${fromName}

— — —
If you'd rather not hear from us, unsubscribe: ${unsubLink}`

  // Spec 37 — HTML body sent alongside text. Same renderer as T1; the
  // isFinalRetry flag toggles tone + retry-line copy.
  // Spec 34 — pass declineCopy so HTML mirrors the bespoke wording.
  const html = renderDunningEmailHtml({
    customerName,
    planName,
    amount,
    currency,
    retryDateStr,
    updateLink,
    unsubLink,
    fromName,
    isFinalRetry,
    declineCopy,
  })

  const res = await callWithRetry(
    () =>
      resend.emails.send({
        from,
        to: email,
        subject,
        text: body,
        html,
        headers: listUnsubscribeHeaders(subscriberId),
      }),
    { ctx: `sendDunningFollowup_${type}` },
  )

  if (res.error) {
    await logEvent({
      name: 'email_send_failed',
      properties: { subscriberId, type, errorMessage: res.error.message },
    })
    throw new Error(`Resend error: ${res.error.message}`)
  }

  // Spec 28 partial unique index extended in migration 028 to cover
  // dunning_t2 / dunning_t3 — at-most-once even on cron retries.
  await recordEmailSentIdempotent(
    {
      subscriberId,
      gmailMessageId: res.data?.id ?? '',
      type,
      subject,
      bodyText: body,
    },
    `sendDunningFollowup_${type}`,
  )

  logEvent({
    name: 'email_sent',
    properties: { subscriberId, emailType: type, subject, messageId: res.data?.id ?? '' },
  })
}

/**
 * Spec 29 — Password reset email. Plain-text transactional auth email.
 * No unsubscribe footer, no DNC check, no AI-pause check — this is an
 * account-recovery email, not a marketing/win-back email.
 */
export async function sendPasswordResetEmail(opts: {
  to: string
  resetUrl: string
}): Promise<void> {
  const { to, resetUrl } = opts
  const resend = getResendClient()

  const subject = 'Reset your Winback password'
  const body = `Someone requested a password reset for this Winback account.

If it was you, open this link to set a new password:
${resetUrl}

This link expires in 24 hours and can only be used once. If you've requested
multiple reset emails, only the most recent link will work.

If you didn't request this, you can ignore this email — your password won't change.`
  const html = renderPasswordResetHtml({ resetUrl })

  const res = await callWithRetry(
    () =>
      resend.emails.send({
        from: 'Winback <noreply@winbackflow.co>',
        to,
        subject,
        text: body,
        html,
      }),
    { ctx: 'sendPasswordResetEmail' },
  )

  if (res.error) {
    throw new Error(`Resend error: ${res.error.message}`)
  }
}

/**
 * Spec 30 — Day-3 onboarding nudge. One-shot transactional email to a
 * founder who registered but hasn't connected Stripe. No unsubscribe link
 * (relationship message; precedent: sendPasswordResetEmail above). The
 * cron tracks idempotency via `wb_customers.onboarding_nudge_sent_at`.
 */
export async function sendOnboardingNudgeEmail(opts: {
  to: string
  founderName: string | null
}): Promise<void> {
  const { to, founderName } = opts
  const resend = getResendClient()

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
  const greeting = founderName ? `Hi ${founderName},` : 'Hi there,'

  const connectUrl = `${base}/onboarding/stripe`
  const subject = 'Still want to set up Winback?'
  const body = `${greeting}

You signed up a few days ago but haven't connected Stripe yet — that's the
only step left. Open this link to finish (takes about 90 seconds):

${connectUrl}

If something's blocking you — Stripe permissions, a question about how it
works, anything else — just hit reply and tell us. We'd genuinely like to
know what's in the way.

If it's not the right fit, ignore this — we'll clean up the unused account
in 90 days.

— Winback`
  const html = renderOnboardingNudgeHtml({ founderName, connectUrl })

  const res = await callWithRetry(
    () =>
      resend.emails.send({
        from: 'Winback <support@winbackflow.co>',
        to,
        subject,
        text: body,
        html,
      }),
    { ctx: 'sendOnboardingNudgeEmail' },
  )

  if (res.error) {
    throw new Error(`Resend error: ${res.error.message}`)
  }
}

/**
 * Spec 30 — Day-83 deletion-warning email. Courtesy notice 7 days before
 * the cron auto-prunes the dormant account. Transactional / functional
 * (not promotional) — no unsubscribe link, same precedent as the nudge.
 * Idempotent via `wb_customers.deletion_warning_sent_at`.
 */
export async function sendDormantAccountDeletionWarningEmail(opts: {
  to: string
  founderName: string | null
}): Promise<void> {
  const { to, founderName } = opts
  const resend = getResendClient()

  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
  const greeting = founderName ? `Hi ${founderName},` : 'Hi there,'

  const connectUrl = `${base}/onboarding/stripe`
  const subject = 'Your Winback account will be deleted in 7 days'
  const body = `${greeting}

You signed up ~12 weeks ago but never connected Stripe. We'll delete the
unused account in 7 days.

To keep it, connect Stripe (~90 seconds): ${connectUrl}

If you'd rather we delete it, ignore this — no further messages. Questions? Hit reply.

— Winback`
  const html = renderDormantWarningHtml({ founderName, connectUrl })

  const res = await callWithRetry(
    () =>
      resend.emails.send({
        from: 'Winback <support@winbackflow.co>',
        to,
        subject,
        text: body,
        html,
      }),
    { ctx: 'sendDormantAccountDeletionWarningEmail' },
  )

  if (res.error) {
    throw new Error(`Resend error: ${res.error.message}`)
  }
}

/**
 * Spec 31 — Day-23 pilot heads-up. Sent ~7 days before `pilot_until`
 * passes so the founder isn't surprised when normal billing kicks in.
 * Plain text, sent from monitored support@ inbox (replies welcome —
 * extension / pricing chats come back here).
 */
export async function sendPilotEndingSoonEmail(opts: {
  to: string
  founderName: string | null
  endsOn: Date
}): Promise<void> {
  const { to, founderName, endsOn } = opts
  const resend = getResendClient()

  const greeting = founderName ? `Hi ${founderName},` : 'Hi there,'
  const dateStr = endsOn.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  })

  const subject = `Your WinbackFlow pilot ends on ${dateStr}`
  const body = `${greeting}

Quick heads-up: your WinbackFlow pilot ends on ${dateStr}. After that,
normal billing kicks in — a single flat monthly fee priced by your own
MRR (Starter $99, Growth $299, Scale $699; Enterprise is sales-handled).
No per-recovery charges, unlimited recovery volume on every tier.

Nothing for you to do right now. The first delivered recovery after the
pilot ends will prompt you in-app to confirm your tier and subscribe —
we'll show you the math (your computed MRR, the resulting tier, the
fee) before any charge.

If you want to discuss pricing or extend the pilot, just hit reply.

Thanks for kicking the tires.

— WinbackFlow`
  const html = renderPilotEndingHtml({ founderName, dateStr })

  const res = await callWithRetry(
    () =>
      resend.emails.send({
        from: 'Winback <support@winbackflow.co>',
        to,
        subject,
        text: body,
        html,
      }),
    { ctx: 'sendPilotEndingSoonEmail' },
  )

  if (res.error) {
    throw new Error(`Resend error: ${res.error.message}`)
  }
}

/**
 * Spec 32 — Email verification. Sent on register, and re-sent on demand
 * via /api/auth/resend-verification. Plain text, no unsubscribe footer
 * (transactional account-lifecycle email; same precedent as
 * sendPasswordResetEmail). From the monitored support@ inbox so a
 * confused founder can hit reply.
 */
export async function sendVerificationEmail(opts: {
  to: string
  founderName: string | null
  verifyUrl: string
}): Promise<void> {
  const { to, founderName, verifyUrl } = opts
  const resend = getResendClient()

  const greeting = founderName ? `Hi ${founderName},` : 'Hi there,'

  const subject = 'Confirm your email to finish setting up Winback'
  const body = `${greeting}

Welcome to Winback. Open the link below to confirm your email and
finish creating your account:

${verifyUrl}

This link expires in 7 days. If you didn't sign up for Winback, you can
safely ignore this email.

— Winback`
  const html = renderVerificationEmailHtml({ founderName, verifyUrl })

  const res = await callWithRetry(
    () =>
      resend.emails.send({
        from: 'Winback <support@winbackflow.co>',
        to,
        subject,
        text: body,
        html,
      }),
    { ctx: 'sendVerificationEmail' },
  )

  if (res.error) {
    throw new Error(`Resend error: ${res.error.message}`)
  }
}

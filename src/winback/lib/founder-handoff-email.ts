import { db } from '@/lib/db'
import { emailsSent } from '@/lib/schema'
import { eq, asc } from 'drizzle-orm'

/**
 * Builds rich notification emails for founders when a subscriber is handed
 * off (spec 21b) and for follow-up events on handed-off subscribers (replies,
 * changelog matches).
 *
 * Each notification gives the founder full context — conversation history +
 * a pre-composed mailto link — so they can respond in one click.
 */

interface SubscriberContext {
  id: string
  email: string | null
  name: string | null
  planName: string | null
  mrrCents: number
  cancellationReason: string | null
  triggerNeed: string | null
  cancelledAt: Date | null
  stripeComment: string | null
  replyText: string | null
}

const APP_URL = (): string =>
  process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'

function reactivationUrl(subscriberId: string): string {
  return `${APP_URL()}/api/reactivate/${subscriberId}`
}

function dashboardUrl(subscriberId: string): string {
  return `${APP_URL()}/dashboard?subscriber=${subscriberId}`
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function daysSince(d: Date | null): number {
  if (!d) return 0
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24))
}

/**
 * Loads the conversation history for a subscriber — every email we sent + their
 * replies — sorted oldest first.
 */
async function loadConversation(subscriberId: string) {
  return await db
    .select({
      id: emailsSent.id,
      type: emailsSent.type,
      subject: emailsSent.subject,
      sentAt: emailsSent.sentAt,
      repliedAt: emailsSent.repliedAt,
    })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, subscriberId))
    .orderBy(asc(emailsSent.sentAt))
}

function formatConversation(
  emails: Awaited<ReturnType<typeof loadConversation>>,
  subscriber: SubscriberContext,
): string {
  const lines: string[] = []
  for (const e of emails) {
    const day = daysSince(e.sentAt)
    lines.push(`[Day ${day}] You sent: ${e.type}`)
    if (e.subject) lines.push(`  Subject: ${e.subject}`)
    if (e.repliedAt) {
      const replyDay = daysSince(e.repliedAt)
      lines.push(`[Day ${replyDay}] ${subscriber.name ?? 'They'} replied`)
    }
    lines.push('')
  }
  if (subscriber.replyText) {
    lines.push('LATEST REPLY TEXT:')
    lines.push(`"${subscriber.replyText.slice(0, 500)}"`)
  }
  return lines.join('\n')
}

function buildMailto(params: {
  subscriberEmail: string
  firstName: string
  founderName: string
  reactivationLink: string
  conversationQuote: string
}): string {
  const subject = `Re: About your subscription`
  const body = `Hi ${params.firstName},

[Your message here]

When you're ready to come back, here's your direct link:
${params.reactivationLink}

— ${params.founderName}

${params.conversationQuote}`

  // Indent the conversation quote with > for email-style quoting in the mailto body.
  return `mailto:${encodeURIComponent(params.subscriberEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/**
 * Build the initial handoff notification — sent when MAX_FOLLOWUPS is reached
 * and the AI hands off to the founder.
 */
export async function buildHandoffNotification(params: {
  subscriber: SubscriberContext
  founderName: string
}): Promise<{ subject: string; body: string }> {
  const { subscriber, founderName } = params
  const firstName = subscriber.name?.split(' ')[0] ?? 'there'
  const conversation = await loadConversation(subscriber.id)
  const conversationText = formatConversation(conversation, subscriber)
  const reactivation = reactivationUrl(subscriber.id)
  const dashboard = dashboardUrl(subscriber.id)

  const conversationQuote = subscriber.replyText
    ? `> Their last reply: ${subscriber.replyText.slice(0, 200)}`
    : ''

  const mailto = subscriber.email
    ? buildMailto({
        subscriberEmail: subscriber.email,
        firstName,
        founderName,
        reactivationLink: reactivation,
        conversationQuote,
      })
    : null

  const cancelledDays = daysSince(subscriber.cancelledAt)

  const subject = `[Winback] Action needed — ${subscriber.name ?? subscriber.email ?? 'Subscriber'} (${subscriber.cancellationReason ?? 'follow-up'})`

  const body = `Hi ${founderName},

${subscriber.name ?? subscriber.email ?? 'A subscriber'} replied to your win-back email and the AI follow-ups have been exhausted. They're worth a personal touch.

──────────────────────────────────────
SUBSCRIBER
${subscriber.name ?? '(no name)'} — ${subscriber.email ?? '(no email)'}
Plan: ${subscriber.planName ?? '?'} (${fmtMoney(subscriber.mrrCents)}/mo)
Cancelled: ${cancelledDays} days ago
Reason: ${subscriber.cancellationReason ?? '(unknown)'}
What they need: ${subscriber.triggerNeed ?? '(no trigger captured)'}
──────────────────────────────────────

CONVERSATION HISTORY:

${conversationText}

──────────────────────────────────────
${mailto ? `→ REPLY TO ${firstName}: ${mailto}\n\n  (opens your email client with the conversation pre-quoted +\n   their reactivation link included)\n\n` : '  (subscriber has no email on file)\n\n'}→ View full details: ${dashboard}
`

  return { subject, body }
}

/**
 * Sent when a handed-off subscriber replies to a previous email. The AI no
 * longer auto-replies — instead the founder is told and can take it from there.
 */
export async function buildReplyAfterHandoffNotification(params: {
  subscriber: SubscriberContext
  founderName: string
  newReplyText: string
}): Promise<{ subject: string; body: string }> {
  const { subscriber, founderName, newReplyText } = params
  const firstName = subscriber.name?.split(' ')[0] ?? 'there'
  const reactivation = reactivationUrl(subscriber.id)
  const dashboard = dashboardUrl(subscriber.id)

  const mailto = subscriber.email
    ? buildMailto({
        subscriberEmail: subscriber.email,
        firstName,
        founderName,
        reactivationLink: reactivation,
        conversationQuote: `> ${newReplyText.slice(0, 500)}`,
      })
    : null

  const subject = `[Winback] ${subscriber.name ?? subscriber.email ?? 'Subscriber'} just replied`

  const body = `Hi ${founderName},

${subscriber.name ?? 'A handed-off subscriber'} just replied. Since you're handling this conversation, I'm not auto-responding — over to you.

──────────────────────────────────────
THEIR REPLY:

${newReplyText}
──────────────────────────────────────

${mailto ? `→ REPLY TO ${firstName}: ${mailto}\n\n` : ''}→ View full details: ${dashboard}
`

  return { subject, body }
}

/**
 * Sent when a changelog matches a handed-off subscriber's stated need.
 * Instead of auto-emailing them (which could undercut the founder's own
 * conversation), notify the founder that there's a fresh angle they could use.
 */
export async function buildChangelogMatchAfterHandoffNotification(params: {
  subscriber: SubscriberContext
  founderName: string
  changelogText: string
}): Promise<{ subject: string; body: string }> {
  const { subscriber, founderName, changelogText } = params
  const firstName = subscriber.name?.split(' ')[0] ?? 'there'
  const reactivation = reactivationUrl(subscriber.id)
  const dashboard = dashboardUrl(subscriber.id)

  const mailto = subscriber.email
    ? buildMailto({
        subscriberEmail: subscriber.email,
        firstName,
        founderName,
        reactivationLink: reactivation,
        conversationQuote: `> They originally asked: ${subscriber.triggerNeed ?? subscriber.cancellationReason ?? ''}`,
      })
    : null

  const subject = `[Winback] Changelog match for ${subscriber.name ?? subscriber.email ?? 'a handed-off subscriber'}`

  const body = `Hi ${founderName},

What you just shipped matches what ${subscriber.name ?? 'this subscriber'} asked for when they cancelled. Since you're handling this conversation, I'm not auto-emailing them — but this might be a perfect moment to reach out.

──────────────────────────────────────
THEY ASKED FOR:
${subscriber.triggerNeed ?? subscriber.cancellationReason ?? '(no trigger captured)'}

YOU JUST SHIPPED:
${changelogText.slice(0, 500)}${changelogText.length > 500 ? '…' : ''}
──────────────────────────────────────

${mailto ? `→ REPLY TO ${firstName}: ${mailto}\n\n` : ''}→ View full details: ${dashboard}
`

  return { subject, body }
}

// Exported for testing
export { buildMailto, formatConversation, daysSince }

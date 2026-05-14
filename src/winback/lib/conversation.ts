import { db } from '@/lib/db'
import { emailsSent, subscriberReplies } from '@/lib/schema'
import { eq, desc, asc } from 'drizzle-orm'
import type { ConversationTurn } from './types'

/**
 * Spec 71 — assemble the chronological conversation thread for one
 * subscriber from canonical data (outbound emails + stored replies).
 *
 * Used by the classifier so it sees the full back-and-forth, not just
 * the latest reply. Capped at the most-recent N turns (default 10),
 * each body truncated to MAX_TURN_BODY_CHARS to keep total prompt
 * payload bounded.
 */

const DEFAULT_MAX_TURNS = 10
const MAX_TURN_BODY_CHARS = 3072  // ~3 KB per turn; 10 turns ≈ 30 KB cap

export interface BuildOptions {
  maxTurns?: number
  maxBodyChars?: number
}

export async function buildConversationThread(
  subscriberId: string,
  opts: BuildOptions = {},
): Promise<ConversationTurn[]> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const maxBodyChars = opts.maxBodyChars ?? MAX_TURN_BODY_CHARS

  const [outbound, inbound] = await Promise.all([
    db
      .select({
        id: emailsSent.id,
        type: emailsSent.type,
        subject: emailsSent.subject,
        bodyText: emailsSent.bodyText,
        sentAt: emailsSent.sentAt,
      })
      .from(emailsSent)
      .where(eq(emailsSent.subscriberId, subscriberId))
      .orderBy(asc(emailsSent.sentAt)),
    db
      .select({
        id: subscriberReplies.id,
        body: subscriberReplies.body,
        receivedAt: subscriberReplies.receivedAt,
      })
      .from(subscriberReplies)
      .where(eq(subscriberReplies.subscriberId, subscriberId))
      .orderBy(asc(subscriberReplies.receivedAt)),
  ])

  const merged: ConversationTurn[] = []
  for (const o of outbound) {
    if (!o.sentAt) continue  // skip rows without timestamps (legacy / in-flight)
    const body = o.bodyText ?? ''
    merged.push({
      kind:      'outbound',
      at:        o.sentAt,
      emailType: o.type,
      subject:   o.subject ?? undefined,
      body:      body.length > maxBodyChars ? body.slice(0, maxBodyChars) : body,
      truncated: body.length > maxBodyChars,
    })
  }
  for (const r of inbound) {
    merged.push({
      kind:      'reply',
      at:        r.receivedAt,
      body:      r.body.length > maxBodyChars ? r.body.slice(0, maxBodyChars) : r.body,
      truncated: r.body.length > maxBodyChars,
    })
  }
  merged.sort((a, b) => a.at.getTime() - b.at.getTime())

  // Keep the most-recent N turns. Older context tends to be less
  // signal-bearing than recency, and we need to bound prompt size.
  return merged.slice(-maxTurns)
}

/**
 * Spec 71 — convenience for code that just wants the most recent reply
 * body (e.g. founder-handoff notification rendering, where we quote
 * back what the subscriber last said). Returns null when no replies.
 */
export async function getLatestReply(subscriberId: string): Promise<string | null> {
  const [row] = await db
    .select({ body: subscriberReplies.body })
    .from(subscriberReplies)
    .where(eq(subscriberReplies.subscriberId, subscriberId))
    .orderBy(desc(subscriberReplies.receivedAt))
    .limit(1)
  return row?.body ?? null
}

/**
 * Render a conversation thread as a plain-text block for the classifier
 * prompt. Empty / undefined input → empty string (caller's prompt should
 * omit the conversation section in that case).
 */
export function renderThreadForPrompt(thread: ConversationTurn[] | undefined, anchorAt?: Date): string {
  if (!thread || thread.length === 0) return ''
  const anchor = anchorAt ? anchorAt.getTime() : (thread[0].at.getTime())
  const lines: string[] = ['CONVERSATION SO FAR (chronological, newest last):']
  for (const t of thread) {
    const day = Math.max(0, Math.floor((t.at.getTime() - anchor) / (24 * 60 * 60 * 1000)))
    if (t.kind === 'outbound') {
      lines.push(`[Day ${day}] WE SENT (${t.emailType ?? 'email'}) — subject: ${JSON.stringify(t.subject ?? '')}`)
      if (t.body) {
        lines.push(`  body: ${oneLine(t.body)}${t.truncated ? ' …[truncated]' : ''}`)
      }
    } else {
      lines.push(`[Day ${day}] SUBSCRIBER REPLIED:`)
      lines.push(`  ${oneLine(t.body)}${t.truncated ? ' …[truncated]' : ''}`)
    }
  }
  return lines.join('\n')
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

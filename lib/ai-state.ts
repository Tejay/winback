import { sql, and, or, eq, isNotNull, isNull, SQL } from 'drizzle-orm'
import { churnedSubscribers, subscriberReplies, emailsSent } from './schema'

/**
 * Spec 22b — Derived "AI state" for a subscriber.
 *
 * Collapses the orthogonal underlying columns (`status`, handoff, pause, DNC)
 * into a single action-oriented state that's useful in the dashboard list view.
 *
 * Priority order matters:
 *   1. recovered  → terminal, positive
 *   2. done       → terminal (lost/skipped/unsubscribed)
 *   3. handoff    → founder action needed (highest attention)
 *   4. paused     → founder has taken manual control
 *   5. active     → AI is engaging / will engage
 */

export type AiState = 'active' | 'handoff' | 'paused' | 'recovered' | 'done'

export interface AiStateInputs {
  status: string | null
  doNotContact?: boolean | null
  founderHandoffAt: Date | string | null
  founderHandoffResolvedAt: Date | string | null
  aiPausedUntil: Date | string | null
  aiPausedReason?: string | null
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null
  return typeof v === 'string' ? new Date(v) : v
}

export function aiState(sub: AiStateInputs, now: Date = new Date()): AiState {
  if (sub.status === 'recovered') return 'recovered'
  if (sub.status === 'lost' || sub.status === 'skipped' || sub.doNotContact) return 'done'

  const handoffAt = toDate(sub.founderHandoffAt)
  const handoffResolvedAt = toDate(sub.founderHandoffResolvedAt)
  if (handoffAt && !handoffResolvedAt) return 'handoff'

  const pausedUntil = toDate(sub.aiPausedUntil)
  if (pausedUntil && pausedUntil.getTime() > now.getTime()) return 'paused'

  return 'active'
}

/**
 * Drawer-redesign — "the ball is in the founder's court."
 *
 * True when the subscriber's most-recent inbound reply is newer than the
 * founder's most-recent personal reply (or the founder hasn't replied at
 * all), and the row is still open (not recovered/lost/skipped/DNC).
 *
 * After the AI's listen-only exit email the subscriber may reply; that
 * flips this on. When the founder replies (a `founder_reply` outbound),
 * the ball is back with the subscriber and this goes off — until they
 * reply again. Used for the "Awaiting reply" filter, the per-row flag,
 * and the dashboard count.
 *
 * Returned as a SQL<boolean> so it can be used as a SELECT column, a WHERE
 * condition, and inside a `count(*) filter (...)` aggregate.
 */
export function awaitingReplyExpr(): SQL<boolean> {
  // The outer correlation MUST be fully qualified as
  // "wb_churned_subscribers"."id". Drizzle renders ${churnedSubscribers.id}
  // as the bare "id" when the enclosing SELECT lists the table's own
  // columns (getTableColumns), and inside `from wb_subscriber_replies sr`
  // / `wb_emails_sent es` a bare "id" silently binds to sr.id / es.id —
  // making the correlation always-false. ${churnedSubscribers} renders the
  // table name, so ${churnedSubscribers}."id" is unambiguous in every
  // context (SELECT column, WHERE, count-filter).
  return sql<boolean>`(
    ${churnedSubscribers.status} not in ('recovered', 'lost', 'skipped')
    and ${churnedSubscribers.doNotContact} = false
    and exists (
      select 1 from ${subscriberReplies} sr
      where sr.subscriber_id = ${churnedSubscribers}."id"
        and sr.received_at > coalesce(
          (select max(es.sent_at) from ${emailsSent} es
            where es.subscriber_id = ${churnedSubscribers}."id"
              and es.type = 'founder_reply'),
          '1970-01-01'::timestamptz
        )
    )
  )`
}

export const AI_STATE_FILTERS = ['all', 'active', 'handoff', 'paused', 'recovered', 'done'] as const
export type AiStateFilter = typeof AI_STATE_FILTERS[number]

export function isValidAiStateFilter(value: string): value is AiStateFilter {
  return (AI_STATE_FILTERS as readonly string[]).includes(value)
}

/**
 * Builds a Drizzle SQL condition that matches the given AI state. Intended
 * for use in `/api/subscribers/route.ts` to filter the server-side query.
 */
export function aiStateFilterCondition(filter: AiStateFilter): SQL | undefined {
  if (filter === 'all') return undefined

  if (filter === 'recovered') {
    return eq(churnedSubscribers.status, 'recovered')
  }

  if (filter === 'done') {
    return or(
      eq(churnedSubscribers.status, 'lost'),
      eq(churnedSubscribers.status, 'skipped'),
      eq(churnedSubscribers.doNotContact, true),
    )
  }

  if (filter === 'handoff') {
    // "You active" in the new model. Matches both:
    //   - legacy handoff rows (founder_handoff_at set, not resolved)
    //   - new take-over rows (ai_paused_until in the future, reason='takeover')
    // Both states mean "founder is actively handling this conversation."
    return or(
      and(
        isNotNull(churnedSubscribers.founderHandoffAt),
        isNull(churnedSubscribers.founderHandoffResolvedAt),
      ),
      and(
        isNotNull(churnedSubscribers.aiPausedUntil),
        sql`${churnedSubscribers.aiPausedUntil} > now()`,
        eq(churnedSubscribers.aiPausedReason, 'takeover'),
      ),
    )
  }

  if (filter === 'paused') {
    return and(
      or(
        isNull(churnedSubscribers.founderHandoffAt),
        isNotNull(churnedSubscribers.founderHandoffResolvedAt),
      ),
      isNotNull(churnedSubscribers.aiPausedUntil),
      sql`${churnedSubscribers.aiPausedUntil} > now()`,
    )
  }

  // filter === 'active'
  return and(
    // Not recovered / lost / skipped / DNC
    sql`${churnedSubscribers.status} NOT IN ('recovered', 'lost', 'skipped')`,
    eq(churnedSubscribers.doNotContact, false),
    // Not handed off (or resolved)
    or(
      isNull(churnedSubscribers.founderHandoffAt),
      isNotNull(churnedSubscribers.founderHandoffResolvedAt),
    ),
    // Not currently paused
    or(
      isNull(churnedSubscribers.aiPausedUntil),
      sql`${churnedSubscribers.aiPausedUntil} < now()`,
    ),
  )
}

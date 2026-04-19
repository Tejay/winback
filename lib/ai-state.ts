import { sql, and, or, eq, isNotNull, isNull, SQL } from 'drizzle-orm'
import { churnedSubscribers } from './schema'

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
    return and(
      isNotNull(churnedSubscribers.founderHandoffAt),
      isNull(churnedSubscribers.founderHandoffResolvedAt),
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

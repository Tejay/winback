import { aiState, type AiState, type AiStateInputs } from '@/lib/ai-state'

/**
 * Spec 22b — compact badge showing the derived AI state for a subscriber.
 * Used in the dashboard list view so founders can see at-a-glance who
 * needs their attention.
 */

interface Props {
  sub: AiStateInputs
  /** If true, renders with smaller padding/text for dense tables */
  compact?: boolean
  /** Spec 53 — when the customer is in post-trial billing-paused state
   *  AND the derived ai state would otherwise be `active`, the badge
   *  reads "⏸ Trial ended" (amber) instead of "🤖 AI active" (green).
   *  Handoff / per-subscriber paused / recovered / done badges are
   *  unchanged — those communicate row-specific state the founder
   *  cares about independent of billing. */
  billingPaused?: boolean
}

const STYLES: Record<AiState, { label: string; classes: string }> = {
  active: {
    label: '🤖 AI active',
    classes: 'bg-green-50 text-green-700 border-green-200',
  },
  handoff: {
    label: '👋 Needs you',
    classes: 'bg-amber-50 text-amber-800 border-amber-300',
  },
  paused: {
    label: '⏸ Paused',
    classes: 'bg-blue-50 text-blue-700 border-blue-200',
  },
  recovered: {
    label: '✓ Recovered',
    classes: 'bg-green-50 text-green-700 border-green-200',
  },
  done: {
    label: '× Done',
    classes: 'bg-slate-100 text-slate-500 border-slate-200',
  },
}

// Spec 53 — when billingPaused is true and the row's ai state is `active`,
// the badge becomes this trial-ended pill instead. Naming is "Trial ended"
// not "Paused" to avoid collision with the existing per-subscriber `paused`
// state (founder manually pausing a specific subscriber, spec 22a).
const TRIAL_ENDED_STYLE = {
  label: '⏸ Trial ended',
  classes: 'bg-amber-50 text-amber-700 border-amber-200',
}

export function AiStateBadge({ sub, compact = false, billingPaused = false }: Props) {
  const state = aiState(sub)
  const isBillingPausedActive = billingPaused && state === 'active'
  const style = isBillingPausedActive ? TRIAL_ENDED_STYLE : STYLES[state]

  // For 'paused' show days remaining; for 'done' show why
  let label = style.label
  if (state === 'paused' && sub.aiPausedUntil) {
    const until = new Date(sub.aiPausedUntil)
    const now = Date.now()
    const days = Math.ceil((until.getTime() - now) / (1000 * 60 * 60 * 24))
    if (until.getFullYear() >= 2099) {
      label = '⏸ Paused · ∞'
    } else if (days > 0) {
      label = `⏸ Paused · ${days}d`
    }
  }
  if (state === 'done') {
    if (sub.doNotContact) label = '× Unsubscribed'
    else if (sub.status === 'skipped') label = '× Skipped'
    else label = '× Lost'
  }

  const padding = compact ? 'px-2 py-0.5' : 'px-2.5 py-0.5'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border text-xs font-medium ${padding} ${style.classes}`}
    >
      {label}
    </span>
  )
}

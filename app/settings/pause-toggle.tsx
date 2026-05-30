'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

type PauseScope = 'winback' | 'dunning'

interface PauseToggleProps {
  scope: PauseScope
  initialPaused: boolean
  compact?: boolean
  /** 2026-05-29 — when false (no active platform subscription),
   *  un-pausing is refused by /api/settings/pause with 403
   *  subscribe_first. The toggle disables the un-pause direction
   *  and surfaces "Subscribe to resume" copy so the UI matches the
   *  API rule instead of letting the merchant click into a 403. */
  hasActiveSub?: boolean
}

const SCOPE_LABELS: Record<PauseScope, {
  noun: string
  confirmCopy: string
  liveDesc: string
  pausedDesc: string
}> = {
  winback: {
    noun: 'win-back',
    confirmCopy:
      'Pause win-back emails? No exit emails or reply win-backs will go out until you un-pause. Cancellations continue to be recorded.',
    liveDesc:
      'Winback sends a personalised email immediately after each new voluntary cancellation.',
    pausedDesc:
      'No win-back emails will go out. Cancellations are still recorded on the dashboard — nothing is lost.',
  },
  dunning: {
    noun: 'payment-recovery',
    confirmCopy:
      'Pause payment-recovery emails? No dunning emails will go out for failed-payment subscribers until you un-pause. The failures are still recorded.',
    liveDesc:
      'Winback emails subscribers whose card failed, so they can update payment and stay subscribed.',
    pausedDesc:
      'No payment-recovery emails will go out. Failed-payment subscribers are still recorded on the dashboard.',
  },
}

export function PauseToggle({
  scope,
  initialPaused,
  compact = false,
  hasActiveSub = true,
}: PauseToggleProps) {
  const router = useRouter()
  const [paused, setPaused] = useState(initialPaused)
  const [loading, setLoading] = useState(false)

  const copy = SCOPE_LABELS[scope]

  // Un-pause requires an active platform subscription (matches the API
  // gate at /api/settings/pause). When paused + no sub, the toggle is
  // visually disabled and clicks no-op — the UI tells the merchant
  // they need to subscribe via the danger-zone label, and the dashboard
  // banner is the single-click path to do that.
  const unpauseBlocked = paused && !hasActiveSub

  async function toggle() {
    if (unpauseBlocked) return  // defence in depth — button is also disabled
    const next = !paused
    if (next && !confirm(copy.confirmCopy)) return

    setLoading(true)
    const res = await fetch('/api/settings/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, paused: next }),
    })
    setLoading(false)

    if (!res.ok) {
      // API may still 403 if state shifted between server-render and
      // click. Surface the server's message when it's the sub gate so
      // the merchant sees the same explanation either way.
      const body = await res.json().catch(() => null)
      if (res.status === 403 && body?.error === 'subscribe_first') {
        alert('Subscribe before un-pausing — sends are gated on an active subscription.')
      } else {
        alert('Could not update. Please try again.')
      }
      return
    }

    setPaused(next)
    router.refresh()
  }

  const switchEl = (
    <button
      onClick={toggle}
      disabled={loading || unpauseBlocked}
      aria-pressed={paused}
      aria-label={paused ? `Resume ${copy.noun} sending` : `Pause ${copy.noun} sending`}
      title={unpauseBlocked ? 'Subscribe to resume sends' : undefined}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
        paused ? 'bg-amber-500' : 'bg-green-500'
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
          paused ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </button>
  )

  if (compact) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-slate-500">
            {paused ? 'Paused' : 'Live'}
          </span>
          {switchEl}
        </div>
        {unpauseBlocked && (
          <span className="text-[11px] text-slate-500">
            Subscribe to resume sends
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between py-4">
      <div>
        <div className="text-sm font-medium text-slate-900">
          {paused ? `${copy.noun === 'win-back' ? 'Win-back' : 'Payment recovery'} is paused` : `${copy.noun === 'win-back' ? 'Win-back' : 'Payment recovery'} is live`}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {unpauseBlocked
            ? 'Subscribe to resume sends — un-pause is gated on an active subscription.'
            : paused ? copy.pausedDesc : copy.liveDesc}
        </div>
      </div>
      {switchEl}
    </div>
  )
}

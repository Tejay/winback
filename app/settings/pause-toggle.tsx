'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

interface PauseToggleProps {
  initialPaused: boolean
  compact?: boolean
}

export function PauseToggle({ initialPaused, compact = false }: PauseToggleProps) {
  const router = useRouter()
  const [paused, setPaused] = useState(initialPaused)
  const [loading, setLoading] = useState(false)

  async function toggle() {
    const next = !paused
    if (next && !confirm('Pause Winback? No new win-back emails will go out until you un-pause. Cancellations continue to be recorded.')) return

    setLoading(true)
    const res = await fetch('/api/settings/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: next }),
    })
    setLoading(false)

    if (!res.ok) {
      alert('Could not update. Please try again.')
      return
    }

    setPaused(next)
    router.refresh()
  }

  const switchEl = (
    <button
      onClick={toggle}
      disabled={loading}
      aria-pressed={paused}
      aria-label={paused ? 'Resume sending' : 'Pause sending'}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-rose-500 focus:ring-offset-2 disabled:opacity-50 ${
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
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-slate-500">
          {paused ? 'Paused' : 'Live'}
        </span>
        {switchEl}
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between py-4">
      <div>
        <div className="text-sm font-medium text-slate-900">
          {paused ? 'Sending is paused' : 'Sending is live'}
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          {paused
            ? 'No win-back emails will go out. Cancellations are still recorded on the dashboard — nothing is lost.'
            : 'Winback will send a personalised email within 60 seconds of each new cancellation.'}
        </div>
      </div>
      {switchEl}
    </div>
  )
}

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface SubscriptionActionsProps {
  status: string  // Stripe Subscription status — 'active' | 'past_due' | etc.
  cancelAtPeriodEnd: boolean
  currentPeriodEndIso: string | null
}

/**
 * Cancel / Resume controls on the Settings billing card.
 *
 *  - Active, no cancel queued → "Cancel subscription"
 *  - Active, cancel queued    → "Resume subscription" + end-date notice
 *  - Past-due / unpaid        → no cancel button (customer needs to fix
 *    payment first; canceling without paying could leave them mid-cycle
 *    with nothing). Stripe handles the eventual hard cancel.
 *  - Canceled                  → buttons hidden by parent.
 */
export function SubscriptionActions({
  status,
  cancelAtPeriodEnd,
  currentPeriodEndIso,
}: SubscriptionActionsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  if (status !== 'active' && status !== 'trialing') return null

  async function call(action: 'cancel' | 'reactivate') {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? 'Request failed')
      setConfirming(false)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (cancelAtPeriodEnd) {
    const endDate = currentPeriodEndIso
      ? new Date(currentPeriodEndIso).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : null
    return (
      <div className="mt-4 pt-4 border-t border-slate-100">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-slate-600">
            <strong className="text-slate-900">Subscription ends{endDate ? ` ${endDate}` : ' at cycle end'}.</strong>{' '}
            You'll keep recovering customers until then.
          </p>
          <button
            onClick={() => call('reactivate')}
            disabled={busy}
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? '…' : 'Resume subscription'}
          </button>
        </div>
        {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
      </div>
    )
  }

  if (confirming) {
    return (
      <div className="mt-4 pt-4 border-t border-slate-100">
        <p className="text-sm text-slate-700">
          Cancel your $99/mo subscription? You'll keep access through the
          current cycle, then no further charges.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={() => call('cancel')}
            disabled={busy}
            className="bg-rose-600 text-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-rose-700 disabled:opacity-50"
          >
            {busy ? 'Canceling…' : 'Yes, cancel'}
          </button>
          <button
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="text-sm text-slate-500 hover:text-slate-900"
          >
            Keep subscription
          </button>
        </div>
        {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
      </div>
    )
  }

  return (
    <div className="mt-4 pt-4 border-t border-slate-100">
      <button
        onClick={() => setConfirming(true)}
        className="text-sm text-slate-500 hover:text-slate-900 underline"
      >
        Cancel subscription
      </button>
    </div>
  )
}

'use client'

import { useState } from 'react'

interface SettlementRequiredProps {
  openObligationCents: number
  liveCount: number
  earliestEndsAt: string | null
  latestEndsAt: string | null
  alreadyRequestedAt: string | null
}

// `alreadyRequestedAt` is kept in the props for back-compat but no longer
// drives UI — Stripe Checkout is now the single path. A stale pending row
// will be reused server-side in /api/settings/settlement/checkout.

function pounds(cents: number) {
  return `£${(cents / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function SettlementRequired({
  openObligationCents,
  liveCount,
  earliestEndsAt,
  latestEndsAt,
}: SettlementRequiredProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function startCheckout() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/settlement/checkout', { method: 'POST' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.checkoutUrl) {
        setError(j.error ?? 'Could not start checkout.')
        setLoading(false)
        return
      }
      window.location.href = j.checkoutUrl
    } catch {
      setError('Network error. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="mt-6 border-t border-rose-100 pt-6">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-5">
        <div className="flex items-start gap-3">
          <span className="text-amber-600 text-lg leading-none">&#9888;</span>
          <div>
            <div className="text-sm font-semibold text-amber-900">
              Settlement required
            </div>
            <p className="mt-1.5 text-sm text-amber-900 leading-relaxed">
              You have{' '}
              <strong className="font-semibold">{liveCount}</strong>{' '}
              attributed subscriber{liveCount === 1 ? '' : 's'} with billing
              remaining, totalling{' '}
              <strong className="font-semibold">{pounds(openObligationCents)}</strong>.{' '}
              Under our <a href="/terms" className="underline">Terms</a>, Winback
              bills 15% of each recovered subscriber&rsquo;s revenue for up to
              12 months — deleting your workspace does not waive that obligation.
            </p>
            <p className="mt-2 text-xs text-amber-800">
              Earliest attribution closes {fmtDate(earliestEndsAt)} · latest
              closes {fmtDate(latestEndsAt)}.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {/* Option 1 — settle */}
        <div className="border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            Option 1
          </div>
          <div className="mt-1 text-sm font-semibold text-slate-900">Settle now</div>
          <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
            Pay {pounds(openObligationCents)} now via Stripe. When the payment
            clears, delete unlocks immediately and all billing stops.
          </p>
          <button
            onClick={startCheckout}
            disabled={loading}
            className="mt-3 w-full bg-rose-600 text-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-rose-700 disabled:bg-slate-200 disabled:text-slate-400"
          >
            {loading ? 'Redirecting…' : `Pay ${pounds(openObligationCents)} now`}
          </button>
          {error && <div className="mt-2 text-xs text-rose-600">{error}</div>}
        </div>

        {/* Option 2 — pause */}
        <div className="border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            Option 2
          </div>
          <div className="mt-1 text-sm font-semibold text-slate-900">Pause instead</div>
          <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
            Your attributed subscribers continue to bill until each 12-month
            window closes. No new recoveries, no new emails.
          </p>
          <a
            href="/settings"
            className="mt-3 block text-center border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            Go to Settings
          </a>
        </div>

        {/* Option 3 — wait */}
        <div className="border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            Option 3
          </div>
          <div className="mt-1 text-sm font-semibold text-slate-900">Wait it out</div>
          <p className="mt-1.5 text-xs text-slate-600 leading-relaxed">
            Delete unlocks automatically when your last attribution window
            closes on {fmtDate(latestEndsAt)}.
          </p>
          <a
            href="/dashboard"
            className="mt-3 block text-center border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-1.5 text-sm font-medium hover:bg-slate-50"
          >
            Back to dashboard
          </a>
        </div>
      </div>
    </div>
  )
}

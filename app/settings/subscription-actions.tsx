'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface SubscriptionActionsProps {
  status: string  // Stripe Subscription status — 'active' | 'past_due' | etc.
  cancelAtPeriodEnd: boolean
  currentPeriodEndIso: string | null
  /** 2026-05-29 — retention math surfaced in the cancel-confirm dialog.
   *  Trailing-30d recovered MRR in USD minor units. When passed
   *  together with priceUsdMinor and the ROI >= 1×, the confirm copy
   *  leads with "Last 30 days WinbackFlow recovered $X — N× what you
   *  paid." Mirrors the convention in tier-transparency-block.tsx —
   *  never show a sub-1× ratio, that's worse marketing than nothing. */
  trailing30dRecoveredUsdMinor?: number
  /** Merchant's current monthly fee in USD minor units. Drives both the
   *  ROI denominator and the "$X/mo subscription" line in the confirm
   *  copy (currently hardcoded to $99 — incorrect for Growth+ tiers). */
  priceUsdMinor?: number | null
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
  trailing30dRecoveredUsdMinor = 0,
  priceUsdMinor = null,
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
    // 2026-05-29 — retention slug. Show the ROI math first so the
    // merchant sees what they're walking away from BEFORE the
    // "you'll keep access through the cycle" mechanical line. Hidden
    // when ROI < 1× (sub-1× ratios undermine the pitch — same rule
    // tier-transparency-block.tsx applies for the dashboard view).
    const recoveredUsd = trailing30dRecoveredUsdMinor / 100
    const monthlyFeeUsd = priceUsdMinor != null ? priceUsdMinor / 100 : null
    const roiMultiple =
      priceUsdMinor != null && priceUsdMinor > 0
        ? trailing30dRecoveredUsdMinor / priceUsdMinor
        : null
    const showRetentionSlug = roiMultiple != null && roiMultiple >= 1
    // "Your $X/mo subscription" — was hardcoded to $99 (Starter). Read
    // from priceUsdMinor when available so Growth ($299) / Scale ($699)
    // merchants see the right number.
    const feeLabel =
      monthlyFeeUsd != null ? `$${monthlyFeeUsd.toLocaleString()}/mo` : '$99/mo'
    return (
      <div className="mt-4 pt-4 border-t border-slate-100">
        {showRetentionSlug && (
          <p className="text-sm text-slate-900 mb-2">
            Last 30 days, WinbackFlow recovered{' '}
            <strong>
              ${recoveredUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </strong>{' '}
            for you — <strong>{roiMultiple.toFixed(1)}× what you paid</strong>.
          </p>
        )}
        <p className="text-sm text-slate-700">
          Cancel your {feeLabel} subscription? You&apos;ll keep access through the
          current cycle, then no further charges.
        </p>
        {/* Visual hierarchy intentionally inverts: the safe action (Keep) is
            the primary filled button, and the destructive action (Yes, cancel)
            is a smaller secondary link. Matches the Stripe / GitHub / Google
            convention for destructive-confirmation dialogs — you have to
            consciously pick the destructive one, not just mash Enter. */}
        <div className="mt-3 flex items-center gap-4">
          <button
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] disabled:opacity-50"
          >
            Keep subscription
          </button>
          <button
            onClick={() => call('cancel')}
            disabled={busy}
            className="text-sm text-rose-600 hover:text-rose-700 underline disabled:opacity-50"
          >
            {busy ? 'Canceling…' : 'Yes, cancel'}
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

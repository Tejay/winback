'use client'

import { useState } from 'react'

/**
 * Spec 78 — opt-in toggle for the promo-aware win-back path. OFF by
 * default. When ON, the matcher considers Stripe-synced active
 * promotion codes for Tier 1 + Price-category cancellations.
 *
 * Editing promotions themselves happens in the merchant's Stripe
 * Dashboard — this toggle only controls whether Winback uses them.
 */
export function PromotionsToggle({
  enabled,
  stripeConnected,
}: {
  enabled: boolean
  stripeConnected: boolean
}) {
  const [on, setOn] = useState(enabled)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function flip() {
    if (!stripeConnected) return
    setSaving(true)
    setError(null)
    const next = !on
    // Optimistic update — flip immediately, revert on error
    setOn(next)
    try {
      const res = await fetch('/api/customer/promotions-enabled', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
    } catch (err) {
      setOn(!next)
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-start justify-between gap-6">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-slate-900">
          Allow promotional offers on price-driven win-backs
        </div>
        <p className="text-sm text-slate-500 mt-1 leading-relaxed">
          When on, Winback may include an active Stripe promotion code in win-back emails to customers whose cancellation reason is about price. Edit promotions in your Stripe Dashboard — we sync the active ones automatically.
        </p>
        {!stripeConnected && (
          <p className="text-xs text-amber-700 mt-2">
            Connect Stripe above to enable.
          </p>
        )}
        {error && (
          <p className="text-xs text-rose-700 mt-2">{error}</p>
        )}
      </div>
      <button
        type="button"
        onClick={flip}
        disabled={!stripeConnected || saving}
        aria-pressed={on}
        aria-label="Toggle promotional offers"
        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${
          on ? 'bg-blue-500' : 'bg-slate-300'
        }`}
      >
        <span
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
            on ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  )
}

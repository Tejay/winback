'use client'

import { useState } from 'react'
import type { TierKey } from '@/src/winback/lib/tiers'

/**
 * The single "Subscribe at $X/mo" CTA that commits the customer's tier
 * choice. Always shows the tier-derived price as both the button label
 * and the dollar figure the customer is consenting to.
 *
 * Flow on click:
 *   1. POST /api/billing/activate { confirmedTier }
 *      - 'active' → redirect to /billing/success?session_id=already_active
 *      - 'awaiting_card' → fall through to step 2
 *      - 'tier_mismatch' → reload the page (recommended_tier drifted)
 *      - other / error → render an inline error message
 *   2. POST /api/billing/setup-intent { confirmedTier }
 *      → redirect to the returned Stripe Checkout URL.
 *      The Stripe success_url returns to /billing/success which calls
 *      commitActivation a second time (idempotent) with the same tier.
 */
export function ActivateButton({
  confirmedTier,
  priceUsdMinor,
}: {
  confirmedTier: TierKey | 'custom'
  priceUsdMinor: number
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onClick() {
    setSubmitting(true)
    setError(null)
    try {
      const activateRes = await fetch('/api/billing/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmedTier }),
      })
      const activatePayload = await activateRes.json()

      if (!activateRes.ok) {
        setError(activatePayload.error ?? 'Activation failed. Please try again.')
        setSubmitting(false)
        return
      }

      if (activatePayload.state === 'active') {
        window.location.href = '/billing/success?already_active=1'
        return
      }

      if (activatePayload.state === 'tier_mismatch') {
        // The MRR shifted between page load and click. Reload so the
        // customer sees the (possibly different) tier before confirming
        // again. Never silently bill on the new tier.
        window.location.reload()
        return
      }

      if (
        activatePayload.state === 'pilot' ||
        activatePayload.state === 'enterprise_handoff' ||
        activatePayload.state === 'no_op'
      ) {
        // Customer state shifted out from under us — reload to render
        // the right branch.
        window.location.reload()
        return
      }

      if (activatePayload.state === 'awaiting_card') {
        // Redirect through Stripe Checkout (setup mode) to capture a
        // card. The returned URL will land back at /billing/success
        // which calls commitActivation a second time with the same tier.
        const setupRes = await fetch('/api/billing/setup-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmedTier }),
        })
        const setupPayload = await setupRes.json()
        if (!setupRes.ok || !setupPayload.url) {
          setError(
            setupPayload.error ??
              'Could not start Stripe Checkout. Please try again.',
          )
          setSubmitting(false)
          return
        }
        window.location.href = setupPayload.url
        return
      }

      setError(`Unexpected state: ${activatePayload.state}`)
      setSubmitting(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  const priceLabel = `$${(priceUsdMinor / 100).toLocaleString()} / mo`

  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-6 text-center shadow-sm">
      <button
        type="button"
        onClick={onClick}
        disabled={submitting}
        className="inline-flex items-center justify-center rounded-full bg-[#0f172a] px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#1e293b] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? 'Loading…' : `Subscribe — ${priceLabel}`}
      </button>
      {error && (
        <p className="mt-3 text-sm text-rose-600">{error}</p>
      )}
      <p className="mt-3 text-xs text-slate-500">
        You can cancel anytime via your billing settings — no retention friction.
      </p>
    </div>
  )
}

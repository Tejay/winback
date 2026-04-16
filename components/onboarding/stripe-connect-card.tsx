'use client'

import { CreditCard } from 'lucide-react'
import { useState } from 'react'

/**
 * The Connect-Stripe card extracted as a client component so we can fire a
 * `connect_clicked` telemetry event before navigating to `/api/stripe/connect`.
 * The event is fire-and-forget — we navigate even if the POST fails — so
 * telemetry can never block the user from connecting.
 */
export function StripeConnectCard() {
  const [pending, setPending] = useState(false)

  async function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // Default link navigation is fine, but we want to record the click first.
    // Prevent the default so we can wait one tick for the fetch to leave the
    // tab (browsers will cancel in-flight fetches on unload; `keepalive` keeps
    // it going).
    e.preventDefault()
    setPending(true)
    try {
      await fetch('/api/events/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'connect_clicked', properties: { source: 'onboarding' } }),
        keepalive: true,
      })
    } catch {
      // Telemetry must never block the user from connecting.
    }
    window.location.href = '/api/stripe/connect'
  }

  return (
    <div className="bg-slate-50 rounded-xl border border-slate-100 p-5 flex items-center justify-between gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <div className="bg-blue-600 rounded-xl w-10 h-10 flex items-center justify-center flex-shrink-0">
          <CreditCard className="w-5 h-5 text-white" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900">Stripe</div>
          <div className="text-xs text-slate-500 truncate">
            Subscription data &amp; cancellation events
          </div>
        </div>
      </div>
      {/* Primary CTA — deliberately larger than the default primary button so
          it's unambiguously the next step on the page. Matches the landing
          hero button size (px-7 py-3 text-base) for brand consistency. */}
      <a
        href="/api/stripe/connect"
        onClick={handleClick}
        aria-disabled={pending}
        className="bg-[#0f172a] text-white rounded-full px-7 py-3 text-base font-medium hover:bg-[#1e293b] shadow-sm hover:shadow-md transition-shadow whitespace-nowrap aria-disabled:opacity-60 aria-disabled:cursor-wait focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        {pending ? 'Connecting…' : 'Connect Stripe →'}
      </a>
    </div>
  )
}

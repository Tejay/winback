'use client'

import { useEffect, useState } from 'react'

/**
 * Spec 79 follow-up — dismissible post-ship insight.
 *
 * The card itself is read-only (its data is written by the weekly
 * cluster-cancellations cron). The merchant can dismiss it; we persist
 * the dismissal in localStorage keyed on the theme id. When the next
 * cron run wipes + reinserts the table, the new theme rows get fresh
 * ids — so an old dismissal naturally stops applying once new data
 * arrives. Cleaner than a DB column and we don't need cross-device
 * sync for a transient nudge.
 *
 * Visual: matches the colored-rail family used by the primary theme
 * cards. Indigo 4px left rail + soft indigo fade tint so it reads as
 * "same family, different meaning" — not loud, not a warning.
 */

export interface PostShipInsightData {
  id:                              string
  title:                           string
  description:                     string
  customerCount:                   number
  sampleQuotes:                    string[]
  addressesImprovementTitle?:      string | null
  addressesImprovementDateShipped?: string | null
}

const DISMISS_KEY_PREFIX = 'wb_psi_dismissed_'

export function PostShipInsight({ insight }: { insight: PostShipInsightData }) {
  const [dismissed, setDismissed] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  // Read dismissal state from localStorage on mount (SSR-safe: we render
  // the card on the server, then hide it client-side if dismissed).
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DISMISS_KEY_PREFIX + insight.id)
      if (stored === '1') setDismissed(true)
    } catch {
      // localStorage may be blocked (private mode, embedded iframe) —
      // dismiss falls back to in-memory only.
    }
    setHydrated(true)
  }, [insight.id])

  function dismiss() {
    setDismissed(true)
    try {
      window.localStorage.setItem(DISMISS_KEY_PREFIX + insight.id, '1')
    } catch {
      // ignore — in-memory dismiss is fine for this session
    }
  }

  if (dismissed) return null

  // Until we've checked localStorage, render the card normally — the
  // flash is invisible if it wasn't dismissed, and brief if it was.
  // Better than rendering nothing on first paint and flashing the
  // card in for non-dismissed users.
  void hydrated

  const title = insight.addressesImprovementTitle ?? '(reason)'
  const shipped = insight.addressesImprovementDateShipped
  const shippedAgo = shipped
    ? Math.floor((Date.now() - new Date(shipped + 'T00:00:00Z').getTime()) / (24 * 60 * 60 * 1000))
    : null

  return (
    <div
      className="rounded-2xl border border-slate-100 shadow-sm px-6 py-4 relative border-l-4 border-l-indigo-500"
      style={{ backgroundImage: 'linear-gradient(to right, #eef2ff 0%, #ffffff 35%)' }}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss insight"
        className="absolute top-3 right-3 text-slate-400 hover:text-slate-700 text-sm leading-none p-1"
      >
        ×
      </button>

      <div className="flex items-start gap-3 pr-6">
        <div className="text-base leading-none mt-0.5 opacity-80">💡</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-indigo-700">Insight</span>
            <span className="text-xs text-slate-400">post-ship feedback</span>
          </div>
          <div className="text-sm font-semibold text-slate-900 mt-1">
            Customers still cite this after you shipped <span className="italic">&ldquo;{title}&rdquo;</span>.
          </div>
          <p className="text-sm text-slate-600 mt-1 leading-relaxed">
            {shippedAgo !== null && (
              <>You shipped this <strong className="text-slate-700">{shippedAgo} day{shippedAgo === 1 ? '' : 's'} ago</strong>. </>
            )}
            Since then, <strong className="text-slate-700">{insight.customerCount} customer{insight.customerCount === 1 ? '' : 's'}</strong> cancelled mentioning the same area — {insight.description.replace(/\.$/, '')}.
          </p>
          {insight.sampleQuotes.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700 select-none">
                See what they said ▸
              </summary>
              <ul className="mt-2 space-y-1.5 pl-3 border-l-2 border-slate-100">
                {insight.sampleQuotes.map((q, i) => (
                  <li key={i} className="text-xs text-slate-600 italic">&ldquo;{q}&rdquo;</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
    </div>
  )
}

'use client'

import { useEffect, useState } from 'react'

/**
 * Spec 76 (admin polish) — small "Last updated · Refresh" affordance.
 *
 * Used on admin pages that load once on mount and otherwise have no
 * freshness signal (customers, billing, audit log). The relative
 * timestamp re-renders every 30s via a state-driven setInterval so it
 * stays accurate without polling the API.
 *
 * The /admin Overview page already polls every 30s and surfaces its own
 * "Live counters refresh every 30 seconds" copy, so it doesn't use this.
 */
export function RefreshAffordance({
  lastLoadedAt,
  onRefresh,
  loading,
}: {
  lastLoadedAt: number | null
  onRefresh: () => void
  loading: boolean
}) {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const label = lastLoadedAt ? millisecondsAgo(Date.now() - lastLoadedAt) : '…'
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <span>Last updated <strong className="text-slate-700">{label}</strong></span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="rounded-full border border-slate-200 bg-white px-3 py-1 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Refresh"
      >
        {loading ? 'Refreshing…' : '↻ Refresh'}
      </button>
    </div>
  )
}

function millisecondsAgo(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 5)     return 'just now'
  if (s < 60)    return `${s}s ago`
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

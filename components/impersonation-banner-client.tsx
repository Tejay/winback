'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0:00'
  const totalSecs = Math.floor(ms / 1000)
  const m = Math.floor(totalSecs / 60)
  const s = totalSecs % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function ImpersonationBannerClient({
  targetEmail,
  adminEmail,
  expiresAt,
}: {
  targetEmail: string
  adminEmail: string
  expiresAt: string
}) {
  const router = useRouter()
  const [remaining, setRemaining] = useState(() => new Date(expiresAt).getTime() - Date.now())
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(new Date(expiresAt).getTime() - Date.now())
    }, 1000)
    return () => clearInterval(id)
  }, [expiresAt])

  async function stop() {
    setStopping(true)
    try {
      const res = await fetch('/api/admin/actions/stop-impersonating', { method: 'POST' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      // Hard reload so the new cookie is picked up by all server components.
      window.location.href = json.redirect ?? '/admin'
    } catch (e) {
      alert(`Stop failed: ${e instanceof Error ? e.message : String(e)}`)
      setStopping(false)
    }
  }

  return (
    <div className="bg-red-600 text-white text-sm">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold flex-shrink-0">⚠ Impersonating</span>
          <span className="truncate">{targetEmail}</span>
          <span className="hidden sm:inline text-red-100">·</span>
          <span className="hidden sm:inline text-red-100 truncate">as {adminEmail}</span>
          <span className="hidden md:inline text-red-100 tabular-nums">· {formatRemaining(remaining)}</span>
        </div>
        <button
          onClick={stop}
          disabled={stopping}
          className="flex-shrink-0 bg-white text-red-700 hover:bg-red-50 rounded-full px-3 py-1 text-xs font-semibold disabled:opacity-50"
        >
          {stopping ? 'Stopping…' : 'Stop impersonating'}
        </button>
      </div>
    </div>
  )
}

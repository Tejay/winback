'use client'

import { useEffect, useState } from 'react'

interface ActivePilot {
  customerId: string
  email: string
  founderName: string | null
  pilotUntil: string | null
  daysRemaining: number | null
  headsUpSent: boolean
  stripeConnected: boolean
}

interface PendingToken {
  tokenId: string
  note: string | null
  expiresAt: string
  createdAt: string
  createdByEmail: string | null
}

interface PilotsResponse {
  slotsUsed: number
  capacity: number
  activePilots: ActivePilot[]
  pendingTokens: PendingToken[]
}

export function PilotsClient() {
  const [data, setData] = useState<PilotsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [note, setNote] = useState('')
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/pilots', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load pilots')
      setData(json)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function issuePilot() {
    setIssuing(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/actions/issue-pilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to issue pilot')
      setIssuedUrl(json.url)
      setNote('')
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setIssuing(false)
    }
  }

  async function copyUrl() {
    if (!issuedUrl) return
    try {
      await navigator.clipboard.writeText(issuedUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore — clipboard not available
    }
  }

  const slotsUsed = data?.slotsUsed ?? 0
  const capacity = data?.capacity ?? 10
  const atCapacity = slotsUsed >= capacity

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          Pilot program
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Pilots.</h1>
        <p className="text-sm text-slate-500 mt-1">
          Up to {capacity} active or pending pilots at any time. Each pilot
          gets a 30-day free window — no platform fee, no win-back fees.
        </p>
      </header>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">
          {error}
        </div>
      )}

      {/* Issue panel */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-900">Issue pilot invite</h2>
          <span className={`text-xs font-medium ${atCapacity ? 'text-amber-700' : 'text-slate-500'}`}>
            {slotsUsed} / {capacity} slots used
          </span>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note — e.g. founder name or company"
            disabled={issuing || atCapacity}
            className="flex-1 border border-slate-200 rounded-full px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={issuePilot}
            disabled={issuing || atCapacity}
            className={`rounded-full px-5 py-2 text-sm font-medium ${
              issuing || atCapacity
                ? 'bg-slate-200 text-slate-400 cursor-not-allowed'
                : 'bg-[#0f172a] text-white hover:bg-[#1e293b]'
            }`}
          >
            {issuing ? 'Issuing…' : atCapacity ? 'Cap reached' : 'Issue pilot invite'}
          </button>
        </div>

        {issuedUrl && (
          <div className="mt-4 bg-blue-50 border border-blue-200 rounded-xl p-3">
            <div className="text-xs font-semibold uppercase tracking-widest text-blue-700 mb-1">
              Pilot signup URL — copy and share
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs text-slate-700 break-all bg-white border border-slate-200 rounded px-2 py-1.5">
                {issuedUrl}
              </code>
              <button
                type="button"
                onClick={copyUrl}
                className="text-xs font-medium px-3 py-1.5 rounded-full bg-[#0f172a] text-white hover:bg-[#1e293b]"
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <div className="text-xs text-slate-500 mt-2">
              Single-use. Expires in 14 days. The founder lands on /register
              with a "🚀 Pilot invite" badge above the form.
            </div>
          </div>
        )}
      </div>

      {/* Active pilots */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500 mb-2">
          Active pilots ({data?.activePilots.length ?? 0})
        </h2>
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-left px-4 py-3">Email</th>
                <th className="text-left px-4 py-3">Stripe</th>
                <th className="text-left px-4 py-3">Pilot ends</th>
                <th className="text-right px-4 py-3">Days left</th>
                <th className="text-left px-4 py-3">Heads-up sent?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-6 text-slate-400">Loading…</td></tr>
              ) : (data?.activePilots.length ?? 0) === 0 ? (
                <tr><td colSpan={5} className="px-4 py-6 text-slate-400">No active pilots yet.</td></tr>
              ) : data!.activePilots.map((p) => (
                <tr key={p.customerId} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">{p.email}</div>
                    {p.founderName && (
                      <div className="text-xs text-slate-500">{p.founderName}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {p.stripeConnected ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200 font-medium">
                        ✓ connected
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium">
                        ○ not yet
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {p.pilotUntil ? new Date(p.pilotUntil).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    }) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {p.daysRemaining ?? 0}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {p.headsUpSent ? (
                      <span className="text-green-700">✓ sent</span>
                    ) : (
                      <span className="text-slate-400">pending</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Pending tokens */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500 mb-2">
          Pending invites ({data?.pendingTokens.length ?? 0})
        </h2>
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-left px-4 py-3">Note</th>
                <th className="text-left px-4 py-3">Issued</th>
                <th className="text-left px-4 py-3">Expires</th>
                <th className="text-left px-4 py-3">Issued by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr><td colSpan={4} className="px-4 py-6 text-slate-400">Loading…</td></tr>
              ) : (data?.pendingTokens.length ?? 0) === 0 ? (
                <tr><td colSpan={4} className="px-4 py-6 text-slate-400">No pending invites.</td></tr>
              ) : data!.pendingTokens.map((t) => (
                <tr key={t.tokenId} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-900">{t.note ?? <span className="text-slate-400">—</span>}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{relative(t.createdAt)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{relative(t.expiresAt)}</td>
                  <td className="px-4 py-3 text-xs text-slate-500">{t.createdByEmail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function relative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(ms)
  const days = Math.round(abs / (1000 * 60 * 60 * 24))
  if (days === 0) {
    const hours = Math.round(abs / (1000 * 60 * 60))
    return ms >= 0 ? `in ${hours}h` : `${hours}h ago`
  }
  return ms >= 0 ? `in ${days}d` : `${days}d ago`
}

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface CustomerRow {
  id: string
  email: string
  founderName: string | null
  productName: string | null
  plan: string | null
  stripeConnected: boolean
  stripeAccountId: string | null
  pausedAt: string | null
  subsCount: number
  recoveriesCount: number
  lastEventAt: string | null
  createdAt: string
}

type Filter = 'all' | 'stuck_on_signup'

export function CustomersClient() {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [rows, setRows] = useState<CustomerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      load(q, filter)
    }, q ? 200 : 0)  // debounce typing slightly
    return () => clearTimeout(t)
  }, [q, filter])

  async function load(query: string, filter: Filter) {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (query) params.set('q', query)
      if (filter !== 'all') params.set('filter', filter)
      const qs = params.toString()
      const url = qs ? `/api/admin/customers?${qs}` : '/api/admin/customers'
      const res = await fetch(url, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load customers')
      setRows(json.rows)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          All customers
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Customers.</h1>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFilter('all')}
          className={`text-xs font-medium px-3 py-1.5 rounded-full border ${
            filter === 'all'
              ? 'bg-[#0f172a] text-white border-[#0f172a]'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
          }`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setFilter('stuck_on_signup')}
          className={`text-xs font-medium px-3 py-1.5 rounded-full border ${
            filter === 'stuck_on_signup'
              ? 'bg-[#0f172a] text-white border-[#0f172a]'
              : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
          }`}
        >
          Stuck on signup
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="🔍 Search by email, founder name, product, or Stripe account id…"
          className="w-full px-4 py-2.5 text-sm border-0 focus:outline-none rounded-2xl"
        />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">
          {error}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="text-left px-4 py-3">Email</th>
              <th className="text-left px-4 py-3">Plan</th>
              <th className="text-left px-4 py-3">Stripe</th>
              <th className="text-right px-4 py-3">#Subs</th>
              <th className="text-right px-4 py-3">#Rec</th>
              <th className="text-left px-4 py-3">Signed up</th>
              <th className="text-left px-4 py-3">Last activity</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-slate-400">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-slate-400">
                {q ? `No customers matching "${q}"` : 'No customers yet'}
              </td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <div className="font-medium text-slate-900">{r.email}</div>
                  {r.founderName && <div className="text-xs text-slate-500">{r.founderName} · {r.productName ?? '(no product)'}</div>}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                    r.plan === 'paid'
                      ? 'bg-green-50 text-green-700 border-green-200'
                      : 'bg-slate-100 text-slate-500 border-slate-200'
                  }`}>
                    {r.plan ?? 'trial'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {r.stripeConnected ? (
                    <span className="text-xs text-green-700">✓ conn</span>
                  ) : (
                    <span className="text-xs text-amber-700">✗ expired</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{r.subsCount}</td>
                <td className="px-4 py-3 text-right tabular-nums">{r.recoveriesCount}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{daysSince(r.createdAt)}</td>
                <td className="px-4 py-3 text-xs text-slate-500">{formatRelative(r.lastEventAt)}</td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/admin/customers/${r.id}`}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    detail →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function daysSince(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24))
  return days === 0 ? 'today' : days === 1 ? '1d' : `${days}d`
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

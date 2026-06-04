'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { RefreshAffordance } from '@/components/admin-refresh'

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

type Filter =
  | 'all'
  | 'stuck_on_signup'
  | 'paywall_stuck'
  | 'oauth_issues'
  | 'backfill_in_flight'
  | 'webhook_silent'

const FILTER_OPTIONS: Array<{ value: Filter; label: string }> = [
  { value: 'all',                label: 'All' },
  { value: 'stuck_on_signup',    label: 'Stuck on signup' },
  { value: 'paywall_stuck',      label: 'Paywall stuck' },
  { value: 'oauth_issues',       label: 'OAuth issues' },
  { value: 'webhook_silent',     label: 'Webhook silent' },
  { value: 'backfill_in_flight', label: 'Backfill in flight' },
]

function isValidFilter(v: string): v is Filter {
  return FILTER_OPTIONS.some((opt) => opt.value === v)
}

// Hard cap mirrored from the API (`/api/admin/customers/route.ts`).
// Used to decide whether to surface the "refine to see more" hint.
const ROW_CAP = 50

export function CustomersClient() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <CustomersClientInner />
    </Suspense>
  )
}

function CustomersClientInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  // PR 2 — initial filter read from ?filter= so deep-links from the
  // /admin Now stuck-cohort tiles arrive on the right cohort.
  const urlFilter = searchParams.get('filter') ?? 'all'
  const initialFilter: Filter = isValidFilter(urlFilter) ? urlFilter : 'all'

  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>(initialFilter)
  const [rows, setRows] = useState<CustomerRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)

  // Keep the URL in sync so filtered views are shareable / refreshable.
  useEffect(() => {
    const params = new URLSearchParams()
    if (filter !== 'all') params.set('filter', filter)
    if (q) params.set('q', q)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, q])

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
      setLastLoadedAt(Date.now())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const atCap = rows.length >= ROW_CAP

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
            All customers
          </div>
          <h1 className="text-3xl font-bold text-slate-900">Customers.</h1>
        </div>
        {/* Spec 76 — last-refreshed timestamp + manual refresh button. The
            customer list doesn't poll, so a stale page sitting open for
            hours otherwise gives no hint that the data is out of date. */}
        <RefreshAffordance lastLoadedAt={lastLoadedAt} onRefresh={() => load(q, filter)} loading={loading} />
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setFilter(opt.value)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border ${
              filter === opt.value
                ? 'bg-[#0f172a] text-white border-[#0f172a]'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {opt.label}
          </button>
        ))}
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

      {/* Spec 76 — row-count indicator. When the API hits its 50-row cap,
          explicitly tell the admin to refine the search; otherwise without
          a "total" they'd assume 50 is the complete result. */}
      {!loading && rows.length > 0 && (
        <div className="text-xs text-slate-500">
          {atCap
            ? <>Showing <strong>{rows.length}</strong> customers (cap reached — refine search to see more)</>
            : <>Showing <strong>{rows.length}</strong> customer{rows.length === 1 ? '' : 's'}</>}
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


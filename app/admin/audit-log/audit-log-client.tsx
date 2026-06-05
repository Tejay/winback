'use client'

import { useEffect, useState, useCallback, Suspense, Fragment } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { RefreshAffordance } from '@/components/admin-refresh'

type Category = 'destructive' | 'sensitive' | 'state-change' | 'operational'

interface Row {
  id: string
  createdAt: string
  action: string
  category: Category
  adminUserId: string | null
  adminEmail: string | null
  customerId: string | null
  customerEmail: string | null
  customerProductName: string | null
  subject: string | null
  properties: Record<string, unknown>
}

interface Admin { id: string; email: string }
interface ActionInfo { action: string; active: boolean; category: Category }

interface Payload {
  rows: Row[]
  actions: ActionInfo[]
  admins: Admin[]
  customerNotFound?: boolean
}

const SINCE_OPTIONS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d',  label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
]

const CATEGORY_LABEL: Record<Category, string> = {
  destructive:    'destructive',
  sensitive:      'sensitive (acts as customer)',
  'state-change': 'state-change',
  operational:    'operational',
}

export function AuditLogClient() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <AuditLogInner />
    </Suspense>
  )
}

function AuditLogInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const [action, setAction] = useState(searchParams.get('action') ?? '')
  const [admin, setAdmin] = useState(searchParams.get('admin') ?? '')
  const [customer, setCustomer] = useState(searchParams.get('customer') ?? '')
  const [since, setSince] = useState(searchParams.get('since') ?? '7d')

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showRaw, setShowRaw] = useState<Set<string>>(new Set())
  // Spec 76 (admin polish) — track when data was last fetched.
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (action) params.set('action', action)
      if (admin) params.set('admin', admin)
      if (customer) params.set('customer', customer)
      if (since) params.set('since', since)
      const res = await fetch(`/api/admin/audit-log?${params}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setData(json)
      setLastLoadedAt(Date.now())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [action, admin, customer, since])

  useEffect(() => {
    const params = new URLSearchParams()
    if (action) params.set('action', action)
    if (admin) params.set('admin', admin)
    if (customer) params.set('customer', customer)
    if (since !== '7d') params.set('since', since)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
    const t = setTimeout(load, customer ? 200 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, admin, customer, since])

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  function toggleRaw(id: string) {
    setShowRaw((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
            Audit log
          </div>
          <h1 className="text-3xl font-bold text-slate-900">Audit log.</h1>
          <p className="text-sm text-slate-500 max-w-2xl">
            Every admin mutation across Phases 1–3. Showing audit events from the chosen window. Older events remain in the database — extend the date filter or query psql directly.
          </p>
        </div>
        {/* Spec 76 — audit-log doesn't poll; this page is often left open
            while triaging incidents, so freshness signal + manual refresh
            matters. */}
        <RefreshAffordance lastLoadedAt={lastLoadedAt} onRefresh={load} loading={loading} />
      </header>

      <section className="bg-white rounded-2xl border border-slate-200 p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <Field label="Action">
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm bg-white"
          >
            <option value="">All actions</option>
            {(() => {
              const all = data?.actions ?? []
              const active = all.filter((a) => a.active)
              const legacy = all.filter((a) => !a.active)
              return (
                <>
                  {active.length > 0 && (
                    <optgroup label="Active">
                      {active.map((a) => <option key={a.action} value={a.action}>{a.action}</option>)}
                    </optgroup>
                  )}
                  {legacy.length > 0 && (
                    <optgroup label="Legacy — no longer performed">
                      {legacy.map((a) => <option key={a.action} value={a.action}>{a.action}</option>)}
                    </optgroup>
                  )}
                </>
              )
            })()}
          </select>
        </Field>
        <Field label="Admin">
          <select
            value={admin}
            onChange={(e) => setAdmin(e.target.value)}
            className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm bg-white"
          >
            <option value="">All admins</option>
            {(data?.admins ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.email}</option>
            ))}
          </select>
        </Field>
        <Field label="Customer (email or UUID)">
          <input
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
            placeholder="alex@acme.co or paste UUID…"
            className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Date range">
          <select
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm bg-white"
          >
            {SINCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">{error}</div>
      )}

      {data?.customerNotFound && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3 text-sm">
          No customer matches <strong>{customer}</strong>.
        </div>
      )}

      <div className="text-xs text-slate-500">
        {loading ? 'Loading…' : `${data?.rows.length ?? 0} event${data?.rows.length === 1 ? '' : 's'}`}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              {/* Spec 76 — leading chevron column so the row's expandability
                  is visible without hovering. Rotates 90° when expanded. */}
              <th className="px-2 py-2 w-6" aria-hidden />
              <th className="text-left px-4 py-2 w-32">Time</th>
              <th className="text-left px-4 py-2 w-48">Action</th>
              <th className="text-left px-4 py-2 w-48">Admin</th>
              <th className="text-left px-4 py-2">Customer</th>
              <th className="text-left px-4 py-2">Subject</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!loading && (data?.rows.length ?? 0) === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-slate-400">No audit events match these filters.</td></tr>
            ) : (data?.rows ?? []).map((r) => {
              const cat = r.category
              const isOpen = expanded.has(r.id)
              return (
                <Fragment key={r.id}>
                  <tr
                    onClick={() => toggle(r.id)}
                    className={`cursor-pointer hover:bg-slate-50 ${categoryStripe(cat)}`}
                  >
                    <td className="px-2 py-2 w-6 align-middle text-slate-400">
                      <span className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden>▸</span>
                      <span className="sr-only">{isOpen ? 'Collapse' : 'Expand'} properties</span>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap align-middle">{relTime(r.createdAt)}</td>
                    <td className="px-4 py-2 align-middle">
                      <span className={`text-xs font-mono font-medium ${categoryText(cat)}`}>{r.action}</span>
                      {cat === 'sensitive' && <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wide text-violet-700 bg-violet-50 border border-violet-200 rounded px-1">acts as customer</span>}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600 align-middle">{r.adminEmail ?? '—'}</td>
                    <td className="px-4 py-2 text-xs align-middle">
                      {r.customerId ? (
                        <Link
                          href={`/admin/customers/${r.customerId}`}
                          className="text-blue-600 hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {r.customerProductName ?? r.customerEmail ?? r.customerId.slice(0, 8)}
                        </Link>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs font-mono text-slate-500 truncate max-w-md align-middle">
                      {r.subject ?? '—'}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} className="px-4 py-3 bg-slate-50">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">Details</span>
                          <button onClick={(e) => { e.stopPropagation(); toggleRaw(r.id) }} className="text-[10px] text-blue-600 hover:underline">
                            {showRaw.has(r.id) ? 'structured' : 'raw JSON'}
                          </button>
                        </div>
                        {showRaw.has(r.id)
                          ? <pre className="text-[11px] font-mono text-slate-700 whitespace-pre-wrap">{JSON.stringify(r.properties, null, 2)}</pre>
                          : <KvGrid props={r.properties} />}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Category legend */}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        {(['destructive', 'sensitive', 'state-change', 'operational'] as Category[]).map((c) => (
          <span key={c} className="flex items-center gap-1.5">
            <span className={`inline-block w-3 h-2 rounded-sm ${legendSwatch(c)}`} />
            {CATEGORY_LABEL[c]}
          </span>
        ))}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">{label}</div>
      {children}
    </label>
  )
}

/** Structured key-value view of an event's properties (parity with Events). */
function KvGrid({ props }: { props: Record<string, unknown> }) {
  const entries = Object.entries(props ?? {})
  if (entries.length === 0) return <div className="text-xs text-slate-400 italic">No properties.</div>
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[140px_1fr] gap-2 text-xs">
          <div className="font-mono text-slate-500 truncate">{k}</div>
          <div className="font-mono text-slate-800 break-all">
            {v === null ? <span className="text-slate-400">null</span>
              : typeof v === 'object' ? JSON.stringify(v)
              : String(v)}
          </div>
        </div>
      ))}
    </div>
  )
}

function categoryStripe(cat: Category): string {
  return cat === 'destructive' ? 'border-l-4 border-red-400'
    : cat === 'sensitive' ? 'border-l-4 border-violet-400'
    : cat === 'state-change' ? 'border-l-4 border-amber-300'
    : 'border-l-4 border-blue-300'
}
function categoryText(cat: Category): string {
  return cat === 'destructive' ? 'text-red-700'
    : cat === 'sensitive' ? 'text-violet-700'
    : cat === 'state-change' ? 'text-amber-700'
    : 'text-blue-700'
}
function legendSwatch(cat: Category): string {
  return cat === 'destructive' ? 'bg-red-400'
    : cat === 'sensitive' ? 'bg-violet-400'
    : cat === 'state-change' ? 'bg-amber-300'
    : 'bg-blue-300'
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

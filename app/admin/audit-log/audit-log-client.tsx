'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'

interface Row {
  id: string
  createdAt: string
  action: string
  adminUserId: string | null
  adminEmail: string | null
  customerId: string | null
  customerEmail: string | null
  customerProductName: string | null
  subject: string | null
  properties: Record<string, unknown>
}

interface Admin { id: string; email: string }

interface Payload {
  rows: Row[]
  knownActions: readonly string[]
  admins: Admin[]
  customerNotFound?: boolean
}

const SINCE_OPTIONS = [
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d',  label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
]

const CATEGORY_BY_ACTION: Record<string, 'destructive' | 'state-change' | 'operational'> = {
  dsr_delete: 'destructive',
  force_oauth_reset: 'destructive',
  pause_customer: 'state-change',
  resolve_open_handoffs: 'state-change',
  unsubscribe_subscriber: 'state-change',
  bulk_unsubscribe: 'state-change',
  billing_retry: 'operational',
  classifier_re_run: 'operational',
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

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          Audit log
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Audit log.</h1>
        <p className="text-sm text-slate-500 max-w-2xl">
          Every admin mutation across Phases 1–3. Showing audit events from the chosen window. Older events remain in the database — extend the date filter or query psql directly.
        </p>
      </header>

      <section className="bg-white rounded-2xl border border-slate-200 p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <Field label="Action">
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm bg-white"
          >
            <option value="">All actions</option>
            {(data?.knownActions ?? []).map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
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
              <th className="text-left px-4 py-2 w-32">Time</th>
              <th className="text-left px-4 py-2 w-48">Action</th>
              <th className="text-left px-4 py-2 w-48">Admin</th>
              <th className="text-left px-4 py-2">Customer</th>
              <th className="text-left px-4 py-2">Subject</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!loading && (data?.rows.length ?? 0) === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-slate-400">No audit events match these filters.</td></tr>
            ) : (data?.rows ?? []).map((r) => {
              const cat = CATEGORY_BY_ACTION[r.action] ?? 'operational'
              return (
                <>
                  <tr
                    key={r.id}
                    onClick={() => toggle(r.id)}
                    className={`cursor-pointer hover:bg-slate-50 ${categoryStripe(cat)}`}
                  >
                    <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap">{relTime(r.createdAt)}</td>
                    <td className={`px-4 py-2 text-xs font-mono font-medium ${categoryText(cat)}`}>{r.action}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{r.adminEmail ?? '—'}</td>
                    <td className="px-4 py-2 text-xs">
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
                    <td className="px-4 py-2 text-xs font-mono text-slate-500 truncate max-w-md">
                      {r.subject ?? '—'}
                    </td>
                  </tr>
                  {expanded.has(r.id) && (
                    <tr key={`${r.id}-props`}>
                      <td colSpan={5} className="px-4 py-3 bg-slate-50">
                        <pre className="text-[11px] font-mono text-slate-700 whitespace-pre-wrap">
                          {JSON.stringify(r.properties, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
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

function categoryStripe(cat: 'destructive' | 'state-change' | 'operational'): string {
  return cat === 'destructive' ? 'border-l-4 border-red-300'
    : cat === 'state-change' ? 'border-l-4 border-amber-300'
    : 'border-l-4 border-blue-300'
}
function categoryText(cat: 'destructive' | 'state-change' | 'operational'): string {
  return cat === 'destructive' ? 'text-red-700'
    : cat === 'state-change' ? 'text-amber-700'
    : 'text-blue-700'
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

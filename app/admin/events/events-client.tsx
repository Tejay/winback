'use client'

import { useEffect, useState, useCallback, Suspense, Fragment } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'

interface EventRow {
  id: string
  name: string
  customerId: string | null
  customerEmail: string | null
  properties: Record<string, unknown>
  createdAt: string
}

interface EventName { name: string; active: boolean }

const SINCE_OPTIONS = [
  { value: '1h',  label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d',  label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
]

/** Coarse quick-filters. Each maps to a set of event names on the server. */
const KIND_CHIPS: Array<{ value: string; label: string }> = [
  { value: '',          label: 'All' },
  { value: 'errors',    label: 'Errors' },
  { value: 'admin',     label: 'Admin' },
  { value: 'lifecycle', label: 'Lifecycle' },
  { value: 'cron',      label: 'Cron' },
]

export function EventsClient() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <EventsClientInner />
    </Suspense>
  )
}

function EventsClientInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const [name, setName] = useState(searchParams.get('name') ?? '')
  const [kind, setKind] = useState(searchParams.get('kind') ?? '')
  const [customer, setCustomer] = useState(searchParams.get('customer') ?? searchParams.get('customerId') ?? '')
  const [since, setSince] = useState(searchParams.get('since') ?? '24h')
  const [q, setQ] = useState(searchParams.get('q') ?? '')

  const [rows, setRows] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [customerNotFound, setCustomerNotFound] = useState(false)
  const [eventsOutsideRange, setEventsOutsideRange] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showRaw, setShowRaw] = useState<Set<string>>(new Set())
  const [eventNames, setEventNames] = useState<EventName[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (name) params.set('name', name)
      if (kind) params.set('kind', kind)
      if (customer) params.set('customer', customer)
      if (since) params.set('since', since)
      if (q) params.set('q', q)
      const res = await fetch(`/api/admin/events?${params}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load events')
      setRows(json.rows)
      setCustomerNotFound(!!json.customerNotFound)
      setEventsOutsideRange(typeof json.customerEventsOutsideRange === 'number' ? json.customerEventsOutsideRange : null)
      if (Array.isArray(json.eventNames)) setEventNames(json.eventNames)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [name, kind, customer, since, q])

  useEffect(() => {
    const params = new URLSearchParams()
    if (name) params.set('name', name)
    if (kind) params.set('kind', kind)
    if (customer) params.set('customer', customer)
    if (since !== '24h') params.set('since', since)
    if (q) params.set('q', q)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
    const t = setTimeout(load, q ? 200 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, kind, customer, since, q])

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

  const activeNames = eventNames.filter((e) => e.active)
  const legacyNames = eventNames.filter((e) => !e.active)
  // If a URL-supplied name isn't in the registry yet, keep it selectable.
  const nameKnown = !name || eventNames.some((e) => e.name === name)

  return (
    <div className="space-y-5">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">Event log</div>
        <h1 className="text-3xl font-bold text-slate-900">Events.</h1>
        <p className="text-sm text-slate-500">Where every &ldquo;investigate →&rdquo; lands. Click a row to expand.</p>
      </header>

      {/* Kind quick-filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {KIND_CHIPS.map((c) => (
          <button
            key={c.value}
            onClick={() => setKind(c.value)}
            className={`text-xs font-medium px-3 py-1.5 rounded-full border ${
              kind === c.value ? 'bg-[#0f172a] text-white border-[#0f172a]' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      <section className="bg-white rounded-2xl border border-slate-200 p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <Field label="Event name">
          <select value={name} onChange={(e) => setName(e.target.value)} className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm bg-white">
            <option value="">All</option>
            {name && !nameKnown && <option value={name}>{name}</option>}
            {activeNames.length > 0 && (
              <optgroup label="Active">
                {activeNames.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
              </optgroup>
            )}
            {legacyNames.length > 0 && (
              <optgroup label="Legacy — no longer emitted">
                {legacyNames.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
              </optgroup>
            )}
          </select>
        </Field>
        <Field label="Customer (email or UUID)">
          <input value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="alex@acme.co or paste UUID…" className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm" />
        </Field>
        <Field label="Date range">
          <select value={since} onChange={(e) => setSince(e.target.value)} className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm bg-white">
            {SINCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Search properties (slow)">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="error, code 401…" className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm" />
        </Field>
      </section>

      {error && <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">{error}</div>}

      {customerNotFound && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3 text-sm">
          No customer matches <strong>{customer}</strong>. Drop the customer filter to search across all customers.
        </div>
      )}

      {eventsOutsideRange !== null && eventsOutsideRange > 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3 text-sm flex items-center justify-between gap-3">
          <span>This customer has <strong>{eventsOutsideRange}</strong> event{eventsOutsideRange === 1 ? '' : 's'} outside the chosen date range.</span>
          <button onClick={() => setSince('30d')} className="text-xs bg-white border border-amber-200 text-amber-800 rounded-full px-3 py-1 hover:bg-amber-100">Extend to 30 days</button>
        </div>
      )}

      <div className="text-xs text-slate-500">{loading ? 'Loading…' : `${rows.length} event${rows.length === 1 ? '' : 's'}`}</div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="w-6 px-2 py-2" aria-hidden />
              <th className="text-left px-3 py-2 w-24">Time</th>
              <th className="text-left px-3 py-2 w-56">Event</th>
              <th className="text-left px-3 py-2 w-44">Customer</th>
              <th className="text-left px-3 py-2">Message</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!loading && rows.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-slate-400">No events match these filters.</td></tr>
            ) : rows.map((r) => {
              const sev = severity(r.name)
              const isOpen = expanded.has(r.id)
              const msg = extractMessage(r.properties)
              return (
                <Fragment key={r.id}>
                  <tr onClick={() => toggle(r.id)} className={`hover:bg-slate-50 cursor-pointer ${stripe(sev)}`}>
                    <td className="px-2 py-2 text-slate-400 align-middle">
                      <span className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden>▸</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap align-middle">{relTime(r.createdAt)}</td>
                    <td className="px-3 py-2 text-xs font-mono align-middle"><span className={nameColor(r.name)}>{r.name}</span></td>
                    <td className="px-3 py-2 text-xs align-middle" onClick={(e) => e.stopPropagation()}>
                      {r.customerId ? (
                        <Link href={`/admin/customers/${r.customerId}`} className="text-blue-600 hover:underline">
                          {r.customerEmail ?? r.customerId.slice(0, 8)}
                        </Link>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 align-middle">
                      {msg
                        ? <span className={sev === 'error' ? 'text-red-700' : ''}>{msg}</span>
                        : <span className="text-slate-400 font-mono truncate block max-w-md">{summarize(r.properties)}</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={5} className="px-4 py-3 bg-slate-50">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">Properties</span>
                          <button onClick={() => toggleRaw(r.id)} className="text-[10px] text-blue-600 hover:underline">
                            {showRaw.has(r.id) ? 'structured' : 'raw JSON'}
                          </button>
                        </div>
                        {showRaw.has(r.id) ? (
                          <pre className="text-[11px] font-mono text-slate-700 whitespace-pre-wrap">{JSON.stringify(r.properties, null, 2)}</pre>
                        ) : (
                          <KvGrid props={r.properties} />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
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

/** Render properties as a key-value grid (objects/arrays shown as compact JSON). */
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

// ── helpers ──

type Severity = 'error' | 'admin' | 'info' | 'normal'

function severity(name: string): Severity {
  if (name.includes('error') || name.includes('failed') || name === 'subscriber_auto_lost' || name === 'webhook_signature_invalid') return 'error'
  if (name.startsWith('admin_')) return 'admin'
  if (name.startsWith('billing_') || name === 'subscriber_recovered' || name.startsWith('email_')) return 'info'
  return 'normal'
}

function stripe(sev: Severity): string {
  return sev === 'error' ? 'border-l-2 border-red-300'
    : sev === 'admin' ? 'border-l-2 border-purple-300'
    : sev === 'info' ? 'border-l-2 border-blue-200'
    : 'border-l-2 border-transparent'
}

function nameColor(name: string): string {
  if (name.includes('error') || name.includes('failed') || name === 'subscriber_auto_lost') return 'text-red-700'
  if (name.startsWith('billing_')) return 'text-green-700'
  if (name.startsWith('email_') || name === 'subscriber_recovered') return 'text-blue-700'
  if (name.startsWith('admin_')) return 'text-purple-700'
  return 'text-slate-700'
}

/** Pull a human-readable message from common property shapes. */
function extractMessage(props: Record<string, unknown> | null): string | null {
  if (!props) return null
  for (const key of ['error', 'errorMessage', 'message', 'reason', 'snippet']) {
    const v = props[key]
    if (typeof v === 'string' && v.length > 0) return v.length > 160 ? v.slice(0, 157) + '…' : v
  }
  return null
}

/** Compact one-line summary of properties when there's no message field. */
function summarize(props: Record<string, unknown> | null): string {
  if (!props) return ''
  const s = JSON.stringify(props)
  return s.length > 120 ? s.slice(0, 117) + '…' : s
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

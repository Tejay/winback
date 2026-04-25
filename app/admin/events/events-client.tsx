'use client'

import { useEffect, useState, useCallback, Suspense } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'

interface EventRow {
  id: string
  name: string
  customerId: string | null
  customerEmail: string | null
  properties: Record<string, unknown>
  createdAt: string
}

const EVENT_NAMES = [
  'admin_action',
  'admin_subscriber_lookup',
  'ai_paused',
  'ai_resumed',
  'billing_card_captured',
  'billing_cron_complete',
  'billing_invoice_created',
  'billing_invoice_failed',
  'billing_invoice_paid',
  'billing_portal_opened',
  'billing_setup_started',
  // Spec 26 — observability error events
  'classifier_failed',
  'email_replied',
  'email_send_failed',
  'email_sent',
  'founder_handoff_triggered',
  'handoff_resolved_manually',
  'handoff_snoozed',
  'landing_viewed',
  'link_clicked',
  'oauth_completed',
  'oauth_denied',
  'oauth_error',
  'oauth_redirect',
  'onboarding_stripe_viewed',
  'proactive_nudge_sent',
  'reactivate_already_active',
  'reactivate_checkout_started',
  'reactivate_failed',
  'subscriber_auto_lost',
  'subscriber_recovered',
  'subscriber_unsubscribed',
  'webhook_signature_invalid',
]

const SINCE_OPTIONS = [
  { value: '1h',  label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d',  label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
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
  // Accept either ?customer (preferred) or ?customerId (legacy) on initial load.
  const [customer, setCustomer] = useState(
    searchParams.get('customer') ?? searchParams.get('customerId') ?? '',
  )
  const [since, setSince] = useState(searchParams.get('since') ?? '24h')
  const [q, setQ] = useState(searchParams.get('q') ?? '')

  const [rows, setRows] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [customerNotFound, setCustomerNotFound] = useState(false)
  const [eventsOutsideRange, setEventsOutsideRange] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (name) params.set('name', name)
      if (customer) params.set('customer', customer)
      if (since) params.set('since', since)
      if (q) params.set('q', q)
      const res = await fetch(`/api/admin/events?${params}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load events')
      setRows(json.rows)
      setCustomerNotFound(!!json.customerNotFound)
      setEventsOutsideRange(typeof json.customerEventsOutsideRange === 'number' ? json.customerEventsOutsideRange : null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [name, customer, since, q])

  useEffect(() => {
    // Sync filters to URL so links are shareable.
    const params = new URLSearchParams()
    if (name) params.set('name', name)
    if (customer) params.set('customer', customer)
    if (since !== '24h') params.set('since', since)
    if (q) params.set('q', q)
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
    const t = setTimeout(load, q ? 200 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, customer, since, q])

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          Event log
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Events.</h1>
      </header>

      <section className="bg-white rounded-2xl border border-slate-200 p-4 grid grid-cols-1 md:grid-cols-4 gap-3">
        <Field label="Event name">
          <select
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm bg-white"
          >
            <option value="">All</option>
            {EVENT_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
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
        <Field label="Search properties (slow)">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="error, code 401…"
            className="w-full border border-slate-200 rounded-full px-3 py-2 text-sm"
          />
        </Field>
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">
          {error}
        </div>
      )}

      {customerNotFound && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3 text-sm">
          No customer matches <strong>{customer}</strong>. Drop the customer filter to search across all customers.
        </div>
      )}

      {eventsOutsideRange !== null && eventsOutsideRange > 0 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-3 text-sm flex items-center justify-between gap-3">
          <span>
            This customer has <strong>{eventsOutsideRange}</strong> event{eventsOutsideRange === 1 ? '' : 's'} outside the chosen date range.
          </span>
          <button
            onClick={() => setSince('30d')}
            className="text-xs bg-white border border-amber-200 text-amber-800 rounded-full px-3 py-1 hover:bg-amber-100"
          >
            Extend to 30 days
          </button>
        </div>
      )}

      <div className="text-xs text-slate-500">
        {loading ? 'Loading…' : `${rows.length} event${rows.length === 1 ? '' : 's'}`}
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="text-left px-4 py-2 w-24">Time</th>
              <th className="text-left px-4 py-2 w-56">Event</th>
              <th className="text-left px-4 py-2">Customer</th>
              <th className="text-left px-4 py-2">Properties</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!loading && rows.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-slate-400">No events match these filters.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.id} onClick={() => toggle(r.id)} className="hover:bg-slate-50 cursor-pointer align-top">
                <td className="px-4 py-2 text-xs text-slate-500 whitespace-nowrap">{relTime(r.createdAt)}</td>
                <td className="px-4 py-2 text-xs font-mono">
                  <span className={nameColor(r.name)}>{r.name}</span>
                </td>
                <td className="px-4 py-2 text-xs text-slate-600">{r.customerEmail ?? r.customerId?.slice(0, 8) ?? '—'}</td>
                <td className="px-4 py-2 text-xs font-mono text-slate-500">
                  {expanded.has(r.id)
                    ? <pre className="whitespace-pre-wrap">{JSON.stringify(r.properties, null, 2)}</pre>
                    : <span className="truncate block max-w-md">{JSON.stringify(r.properties)}</span>}
                </td>
              </tr>
            ))}
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

function nameColor(name: string): string {
  if (name.includes('error') || name.includes('failed') || name === 'subscriber_auto_lost') return 'text-red-700'
  if (name.startsWith('billing_')) return 'text-green-700'
  if (name.startsWith('email_') || name === 'subscriber_recovered') return 'text-blue-700'
  if (name.startsWith('admin_')) return 'text-purple-700'
  return 'text-slate-700'
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

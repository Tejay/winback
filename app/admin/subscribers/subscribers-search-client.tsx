'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter } from 'next/navigation'

interface Row {
  id: string
  customerId: string
  customerEmail: string | null
  customerProductName: string | null
  customerFounderName: string | null
  email: string | null
  name: string | null
  status: string
  cancelledAt: string | null
  doNotContact: boolean | null
  founderHandoffAt: string | null
  founderHandoffResolvedAt: string | null
  aiPausedUntil: string | null
  handoffReasoning: string | null
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
  mrrCents: number
  cancellationReason: string | null
}

type Cohort = 'drain_paused' | 'unclassified'

const COHORT_LABELS: Record<Cohort, string> = {
  drain_paused: 'Drain-paused queue',
  unclassified: 'Unclassified queue',
}

function isCohort(v: string | null): v is Cohort {
  return v === 'drain_paused' || v === 'unclassified'
}

export function SubscribersSearchClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const customerIdFilter = searchParams.get('customerId')
  // PR 2 — `?cohort=drain_paused|unclassified` arrives from the /admin
  // Now stuck-cohort tiles. Same UX shape as the customerId filter:
  // preloads results without requiring a typed email search.
  const cohortRaw = searchParams.get('cohort')
  const cohortFilter: Cohort | null = isCohort(cohortRaw) ? cohortRaw : null

  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Spec 26 — bulk DNC: track selected subscriber ids for the multi-select.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  // Spec 69 — when the URL has ?customerId=X, fetch the customer-scoped
  // list on mount and display a "Filtered to X" pill with a clear-filter
  // button that strips the query param.
  const [customerLabel, setCustomerLabel] = useState<string | null>(null)

  const fetchCustomerScoped = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/subscribers/search?customerId=${encodeURIComponent(id)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Search failed')
      setRows(json.rows)
      const first = json.rows[0] as Row | undefined
      setCustomerLabel(
        first?.customerProductName ?? first?.customerFounderName ?? first?.customerEmail ?? id.slice(0, 8),
      )
      setSubmitted(null)
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchCohortScoped = useCallback(async (cohort: Cohort) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/subscribers/search?cohort=${encodeURIComponent(cohort)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Search failed')
      setRows(json.rows)
      setSubmitted(null)
      setCustomerLabel(null)
      setSelected(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (customerIdFilter) {
      fetchCustomerScoped(customerIdFilter)
    } else if (cohortFilter) {
      fetchCohortScoped(cohortFilter)
    } else {
      setCustomerLabel(null)
    }
  }, [customerIdFilter, cohortFilter, fetchCustomerScoped, fetchCohortScoped])

  function clearCustomerFilter() {
    router.push('/admin/subscribers')
  }
  function clearCohortFilter() {
    router.push('/admin/subscribers')
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function clearSelection() {
    setSelected(new Set())
  }
  function selectAll() {
    setSelected(new Set(rows.filter((r) => !r.doNotContact).map((r) => r.id)))
  }

  async function bulkDnc() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    setBulkBusy(true)
    setActionMsg(null)
    try {
      const res = await fetch('/api/admin/actions/bulk-unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriberIds: ids }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Bulk DNC failed')
      setActionMsg(`✓ Marked ${json.count} subscriber${json.count === 1 ? '' : 's'} as DNC`)
      clearSelection()
      await refreshCurrentView()
    } catch (e) {
      setActionMsg(`✗ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBulkBusy(false)
    }
  }

  async function search(e?: React.FormEvent) {
    if (e) e.preventDefault()
    const q = email.trim()
    if (!q) return
    setLoading(true)
    setError(null)
    setActionMsg(null)
    try {
      const res = await fetch(`/api/admin/subscribers/search?email=${encodeURIComponent(q)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Search failed')
      setRows(json.rows)
      setSubmitted(q)
      clearSelection()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function rowAction(action: 'unsubscribe' | 'dsr-delete', row: Row) {
    setBusyId(row.id)
    setActionMsg(null)
    try {
      let body: Record<string, unknown>
      if (action === 'dsr-delete') {
        const typed = prompt(
          `This will HARD DELETE the subscriber row for ${row.email} on ${row.customerEmail ?? row.customerId} and all related emails. Type DELETE to confirm:`,
        )
        if (typed !== 'DELETE') {
          setBusyId(null)
          return
        }
        body = { subscriberId: row.id, confirm: 'DELETE' }
      } else {
        body = { subscriberId: row.id }
      }

      const res = await fetch(`/api/admin/actions/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Action failed')
      setActionMsg(`✓ ${action === 'dsr-delete' ? 'Deleted' : 'Marked DNC'}: ${row.email}`)
      // Re-search to refresh the row state
      await refreshCurrentView()
    } catch (e) {
      setActionMsg(`✗ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  async function searchEmail(q: string) {
    const res = await fetch(`/api/admin/subscribers/search?email=${encodeURIComponent(q)}`)
    const json = await res.json()
    if (res.ok) setRows(json.rows)
  }

  /**
   * Spec 69 — re-pull the current view after a row action mutates state.
   * Routes to whichever filter is active: customer-scoped, cohort (PR 2),
   * or the last email search.
   */
  async function refreshCurrentView() {
    if (customerIdFilter) {
      await fetchCustomerScoped(customerIdFilter)
    } else if (cohortFilter) {
      await fetchCohortScoped(cohortFilter)
    } else if (submitted) {
      await searchEmail(submitted)
    }
  }

  function exportRow(row: Row) {
    const url = `/api/admin/subscribers/search?email=${encodeURIComponent(row.email ?? '')}`
    // Reuse the search payload as the export bundle for now — this is the
    // public-row view of the data; for a full DSR Art. 15 export with email
    // history, support should run `npx tsx scripts/dsr.ts export <email>`.
    window.open(url, '_blank', 'noopener')
  }

  return (
    <div className="space-y-6">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          Cross-customer lookup
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Subscribers.</h1>
        <p className="text-sm text-slate-500">
          Find a churned subscriber across every Winback customer&apos;s campaign — for complaint triage and GDPR requests.
        </p>
      </header>

      {customerIdFilter && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-2.5 text-sm flex items-center justify-between">
          <span className="text-blue-900">
            Filtered to <strong>{customerLabel ?? customerIdFilter.slice(0, 8)}</strong>
            <span className="ml-2 text-xs text-blue-700/70">— showing all subscribers for this customer</span>
          </span>
          <button
            onClick={clearCustomerFilter}
            className="text-xs text-blue-700 hover:text-blue-900 font-medium"
          >
            × clear filter
          </button>
        </div>
      )}

      {cohortFilter && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2.5 text-sm flex items-center justify-between">
          <span className="text-amber-900">
            Cohort: <strong>{COHORT_LABELS[cohortFilter]}</strong>
            <span className="ml-2 text-xs text-amber-700/70">
              {cohortFilter === 'drain_paused'
                ? '— subscribers awaiting drain (activated customer, not yet processed)'
                : '— subscribers awaiting classifier (attempts < 3)'}
            </span>
          </span>
          <button
            onClick={clearCohortFilter}
            className="text-xs text-amber-700 hover:text-amber-900 font-medium"
          >
            × clear filter
          </button>
        </div>
      )}

      <form onSubmit={search} className="flex gap-2">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="🔍 Subscriber email address…"
          type="email"
          className="flex-1 border border-slate-200 rounded-full px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          disabled={loading || !email.trim()}
          className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b] disabled:opacity-50"
        >
          {loading ? '…' : 'Search'}
        </button>
      </form>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-3 text-sm">
          {error}
        </div>
      )}
      {actionMsg && (
        <div className={`text-sm rounded-xl px-3 py-2 ${
          actionMsg.startsWith('✓')
            ? 'bg-green-50 text-green-800 border border-green-200'
            : 'bg-red-50 text-red-800 border border-red-200'
        }`}>{actionMsg}</div>
      )}

      {submitted && (
        <div className="text-sm text-slate-500">
          {rows.length === 0 ? (
            <span>No churned subscribers found across any Winback customer for <strong>{submitted}</strong>.</span>
          ) : (
            <span><strong>{rows.length}</strong> match{rows.length === 1 ? '' : 'es'} for <strong>{submitted}</strong></span>
          )}
        </div>
      )}

      {rows.length > 0 && selected.size > 0 && (
        <div className="sticky top-16 z-20 bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center justify-between text-sm">
          <span className="text-amber-900">
            <strong>{selected.size}</strong> selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={selectAll}
              disabled={bulkBusy}
              className="text-xs border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
            >
              Select all (eligible)
            </button>
            <button
              onClick={clearSelection}
              disabled={bulkBusy}
              className="text-xs border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
            >
              Clear
            </button>
            <button
              onClick={bulkDnc}
              disabled={bulkBusy}
              className="text-xs bg-[#0f172a] text-white rounded-full px-3 py-1.5 font-medium hover:bg-[#1e293b] disabled:opacity-50"
            >
              {bulkBusy ? '…' : `Mark all ${selected.size} as DNC`}
            </button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((r) => (
            <SubscriberCard
              key={r.id}
              row={r}
              busy={busyId === r.id}
              selected={selected.has(r.id)}
              onToggleSelected={toggleSelected}
              onAction={rowAction}
              onExport={exportRow}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SubscriberCard({
  row,
  busy,
  selected,
  onToggleSelected,
  onAction,
  onExport,
}: {
  row: Row
  busy: boolean
  selected: boolean
  onToggleSelected: (id: string) => void
  onAction: (action: 'unsubscribe' | 'dsr-delete', row: Row) => void
  onExport: (row: Row) => void
}) {
  const handedOff = !!row.founderHandoffAt && !row.founderHandoffResolvedAt
  const paused = !!row.aiPausedUntil && new Date(row.aiPausedUntil).getTime() > Date.now()
  const aiState = handedOff ? 'handoff' : paused ? 'paused' : row.status === 'recovered' || row.status === 'lost' ? 'done' : 'active'
  // Already-DNC rows are not eligible for bulk DNC — disable the checkbox.
  const dncEligible = !row.doNotContact

  return (
    <div className={`bg-white rounded-2xl border p-4 ${selected ? 'border-amber-400 ring-2 ring-amber-100' : 'border-slate-200'}`}>
      <div className="flex items-start gap-3 mb-2">
        <input
          type="checkbox"
          checked={selected}
          disabled={!dncEligible}
          onChange={() => onToggleSelected(row.id)}
          aria-label={dncEligible ? `Select ${row.email ?? row.id}` : 'Already DNC'}
          title={dncEligible ? 'Select for bulk DNC' : 'Already DNC — can\'t bulk-mark'}
          className="mt-1 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
        />
        <div className="flex-1 flex items-start justify-between gap-4">
          <div>
            <div className="font-medium text-slate-900">{row.name ?? '(no name)'} <span className="text-slate-400 font-normal">· {row.email}</span></div>
          <div className="text-xs text-slate-500 mt-0.5">
            on{' '}
            <Link
              href={`/admin/customers/${row.customerId}`}
              className="text-blue-600 hover:underline"
            >
              {row.customerProductName ?? row.customerFounderName ?? row.customerEmail ?? row.customerId.slice(0, 8)}
            </Link>
            {' · '}
            cancelled {row.cancelledAt ? new Date(row.cancelledAt).toLocaleDateString() : '?'}
            {' · '}
            ${(row.mrrCents / 100).toFixed(2)}/mo
          </div>
        </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge color={statusColor(row.status)}>{row.status}</Badge>
            <Badge color={aiStateColor(aiState)}>AI: {aiState}</Badge>
            {row.doNotContact && <Badge color="red">DNC</Badge>}
            {row.recoveryLikelihood && (
              <Badge color={likelihoodColor(row.recoveryLikelihood)}>
                recovery: {row.recoveryLikelihood}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {row.cancellationReason && (
        <div className="text-sm text-slate-600 italic border-l-2 border-slate-200 pl-3 my-2">
          "{row.cancellationReason}"
        </div>
      )}
      {row.handoffReasoning && (
        <div className="text-xs text-slate-500 italic bg-slate-50 rounded-lg p-2 my-2">
          AI judgment: "{row.handoffReasoning}"
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-100 mt-3">
        <button
          onClick={() => onAction('unsubscribe', row)}
          disabled={busy || row.doNotContact === true}
          className="text-xs border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? '…' : row.doNotContact ? 'Already DNC' : 'Mark DNC'}
        </button>
        <button
          onClick={() => onExport(row)}
          disabled={busy}
          className="text-xs border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50"
        >
          Export JSON
        </button>
        <button
          onClick={() => onAction('dsr-delete', row)}
          disabled={busy}
          className="text-xs border border-red-200 bg-red-50 text-red-800 rounded-full px-3 py-1.5 hover:bg-red-100 disabled:opacity-50"
        >
          Delete (GDPR)
        </button>
        {/* Spec 27 — quick path from this row's quick-scan view to the full
            inspector page (timeline, body view, re-run classifier). */}
        <Link
          href={`/admin/subscribers/${row.id}`}
          className="text-xs ml-auto text-blue-600 hover:underline"
        >
          View full inspector →
        </Link>
      </div>
    </div>
  )
}

type BadgeColor = 'green' | 'amber' | 'red' | 'blue' | 'slate'

function Badge({ color, children }: { color: BadgeColor; children: React.ReactNode }) {
  const colors: Record<BadgeColor, string> = {
    green: 'bg-green-50 text-green-700 border-green-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red:   'bg-red-50 text-red-700 border-red-200',
    blue:  'bg-blue-50 text-blue-700 border-blue-200',
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full border ${colors[color]}`}>
      {children}
    </span>
  )
}

function statusColor(status: string): BadgeColor {
  return status === 'recovered' ? 'green'
    : status === 'contacted' ? 'blue'
    : status === 'lost' ? 'slate'
    : 'amber'
}
function aiStateColor(state: string): BadgeColor {
  return state === 'handoff' ? 'amber'
    : state === 'paused' ? 'slate'
    : state === 'done' ? 'slate'
    : 'blue'
}
function likelihoodColor(l: 'high' | 'medium' | 'low'): BadgeColor {
  return l === 'high' ? 'green' : l === 'medium' ? 'amber' : 'slate'
}

'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { RefreshAffordance } from '@/components/admin-refresh'

/**
 * Phase C — admin billing dashboard, slimmed down.
 *
 * Old engine surfaced per-period billing_runs with retry buttons. Under the
 * new model Stripe Subscriptions handle their own dunning + retries, so the
 * useful admin views are: queued win-back fees that haven't been billed yet
 * (typically waiting on a card), and the weekly MRR-recovered trend.
 */

interface OutstandingRow {
  recoveryId: string
  customerId: string
  recoveredAt: string | null
  planMrrCents: number
  feeCents: number
  period: string
  productName: string | null
  customerEmail: string | null
}

interface ChargedRow {
  recoveryId: string
  customerId: string
  recoveredAt: string | null
  chargedAt: string | null
  refundedAt: string | null
  stripeItemId: string | null
  feeCents: number
  planMrrCents: number
  productName: string | null
  customerEmail: string | null
  withinRefundWindow: boolean
}

interface MrrPoint {
  week: string
  attributionType: string
  cents: number
  n: number
}

interface Payload {
  outstanding: OutstandingRow[]
  mrrTrend: MrrPoint[]
  charged: ChargedRow[]
  stripeMode: 'test' | 'live'
}

export function BillingClient() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Spec 76 (admin polish) — track when data was last fetched.
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/billing', { cache: 'no-store' })
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
  }, [])

  useEffect(() => { load() }, [load])

  const [filter, setFilter] = useState('')

  if (loading && !data) return <p className="text-sm text-slate-500">Loading…</p>
  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
        <strong>Failed to load.</strong> {error}
      </div>
    )
  }
  if (!data) return null

  const filterPredicate = (row: { productName: string | null; customerEmail: string | null }) => {
    const q = filter.trim().toLowerCase()
    if (!q) return true
    const hay = `${row.productName ?? ''} ${row.customerEmail ?? ''}`.toLowerCase()
    return hay.includes(q)
  }
  const filteredOutstanding = data.outstanding.filter(filterPredicate)
  const filteredCharged = data.charged.filter(filterPredicate)

  const totalOutstandingCents = filteredOutstanding.reduce((a, b) => a + b.feeCents, 0)
  const totalOutstandingMrr = filteredOutstanding.reduce((a, b) => a + b.planMrrCents, 0)

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
            Billing operations
          </div>
          <h1 className="text-3xl font-bold text-slate-900">Billing.</h1>
          <p className="text-sm text-slate-500 mt-1">
            Stripe Subscriptions drive monthly billing automatically; this page tracks
            win-back fees that are queued (waiting on a card) and the weekly recovery trend.
          </p>
        </div>
        {/* Spec 76 — billing doesn't poll, so a stale tab open for hours
            otherwise gives no hint that the data is out of date. */}
        <RefreshAffordance lastLoadedAt={lastLoadedAt} onRefresh={load} loading={loading} />
      </header>

      {/* Customer filter (client-side, applies to both sections) */}
      <div>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by customer (product name or email)…"
          className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full max-w-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {filter && (
          <span className="ml-3 text-xs text-slate-500">
            {filteredOutstanding.length} outstanding · {filteredCharged.length} charged
          </span>
        )}
      </div>

      {/* Outstanding win-back fees (queued, not yet billed) */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Outstanding win-back fees
          </div>
          {totalOutstandingCents > 0 && (
            <div className="text-sm text-slate-700">
              <strong>${(totalOutstandingCents / 100).toFixed(2)}</strong> queued
              <span className="text-slate-400"> · across {data.outstanding.length} recoveries · ${(totalOutstandingMrr / 100).toFixed(2)} MRR</span>
            </div>
          )}
        </div>
        {filteredOutstanding.length === 0 ? (
          <div className="text-sm text-slate-400 italic">
            {filter ? 'No outstanding fees match the filter.' : 'No queued win-back fees — every strong recovery has been charged.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-left py-2">Customer</th>
                <th className="text-left py-2">Recovered</th>
                <th className="text-left py-2">Period</th>
                <th className="text-right py-2">MRR</th>
                <th className="text-right py-2">Win-back fee (1× MRR)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredOutstanding.map((r) => (
                <tr key={r.recoveryId} className="hover:bg-slate-50">
                  <td className="py-2">
                    <Link href={`/admin/customers/${r.customerId}`} className="text-blue-600 hover:underline">
                      {r.productName ?? r.customerEmail ?? r.customerId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="py-2 text-xs text-slate-500">
                    {r.recoveredAt ? new Date(r.recoveredAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-2 font-mono text-xs">{r.period}</td>
                  <td className="py-2 text-right tabular-nums">${(r.planMrrCents / 100).toFixed(2)}</td>
                  <td className="py-2 text-right tabular-nums font-semibold">${(r.feeCents / 100).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Charged win-back fees — Spec 67 */}
      <ChargedSection
        rows={filteredCharged}
        totalUnfiltered={data.charged.length}
        filterActive={filter.trim().length > 0}
        stripeMode={data.stripeMode}
        onRefunded={load}
      />

      {/* MRR recovered trend */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          MRR recovered (last 13 weeks)
        </div>
        <MrrTrend points={data.mrrTrend} />
      </section>
    </div>
  )
}

function stripeItemUrl(itemId: string, mode: 'test' | 'live'): string {
  const prefix = mode === 'test' ? '/test' : ''
  return `https://dashboard.stripe.com${prefix}/invoice-items/${itemId}`
}

function ChargedSection({
  rows,
  totalUnfiltered,
  filterActive,
  stripeMode,
  onRefunded,
}: {
  rows: ChargedRow[]
  totalUnfiltered: number
  filterActive: boolean
  stripeMode: 'test' | 'live'
  onRefunded: () => void
}) {
  const [refundTarget, setRefundTarget] = useState<ChargedRow | null>(null)
  const atLimit = totalUnfiltered >= 200

  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Charged win-back fees
        </div>
        {/* Spec 76 — clearer signal when we've hit the 200-row cap. Previously
            this just said "showing 200 most recent" which didn't make clear
            that older fees existed in the DB. Now spells it out. */}
        <div className="text-xs text-slate-400">
          {filterActive
            ? `${rows.length} match${rows.length === 1 ? '' : 'es'}`
            : atLimit
              ? 'Showing 200 most recent — older fees in DB; use the customer filter above to find them'
              : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-400 italic">
          {filterActive ? 'No charged fees match the filter.' : 'No win-back fees have been charged yet.'}
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            <tr>
              <th className="text-left py-2">Customer</th>
              <th className="text-left py-2">Charged</th>
              <th className="text-right py-2">Fee</th>
              <th className="text-left py-2 pl-4">Status</th>
              <th className="text-right py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const refundable = !r.refundedAt && !!r.stripeItemId
              const stripeUrl = r.stripeItemId ? stripeItemUrl(r.stripeItemId, stripeMode) : null
              return (
                <tr key={r.recoveryId} className="hover:bg-slate-50">
                  <td className="py-2">
                    <Link href={`/admin/customers/${r.customerId}`} className="text-blue-600 hover:underline">
                      {r.productName ?? r.customerEmail ?? r.customerId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="py-2 text-xs text-slate-500">
                    {r.chargedAt ? new Date(r.chargedAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-2 text-right tabular-nums font-semibold">
                    ${(r.feeCents / 100).toFixed(2)}
                  </td>
                  <td className="py-2 pl-4">
                    {r.refundedAt ? (
                      <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">
                        Refunded
                      </span>
                    ) : !r.stripeItemId ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200"
                        title="Charged but no Stripe item recorded — resolve via Stripe Dashboard directly"
                      >
                        Item missing
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                        Charged
                        {r.withinRefundWindow && (
                          <span className="text-green-600/60 font-normal"> · within 14d</span>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {stripeUrl && (
                      <a
                        href={stripeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline mr-3"
                      >
                        View in Stripe ↗
                      </a>
                    )}
                    {refundable && (
                      <button
                        onClick={() => setRefundTarget(r)}
                        className="text-xs px-3 py-1 rounded-full border border-slate-200 hover:bg-slate-50 text-slate-700"
                      >
                        Refund
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {refundTarget && (
        <RefundModal
          row={refundTarget}
          onClose={() => setRefundTarget(null)}
          onSuccess={() => { setRefundTarget(null); onRefunded() }}
        />
      )}
    </section>
  )
}

function RefundModal({
  row,
  onClose,
  onSuccess,
}: {
  row: ChargedRow
  onClose: () => void
  onSuccess: () => void
}) {
  const [confirmText, setConfirmText] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const customerLabel = row.productName ?? row.customerEmail ?? row.customerId.slice(0, 8)
  const dollars = `$${(row.feeCents / 100).toFixed(2)}`
  const outsideWindow = !row.withinRefundWindow
  const ready = acknowledged && confirmText === 'REFUND' && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/billing/recoveries/${row.recoveryId}/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'REFUND' }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      onSuccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl border border-slate-200 max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-lg font-semibold text-slate-900 mb-1">
          Refund {dollars} to {customerLabel}?
        </div>
        <p className="text-sm text-slate-600 mb-4">
          {outsideWindow
            ? `This recovery was charged on ${row.chargedAt ? new Date(row.chargedAt).toLocaleDateString() : 'an unknown date'} — outside the 14-day refund policy. Confirm only if support has approved an out-of-window refund.`
            : 'Issues a Stripe credit note (or deletes the pending invoice item if not yet finalized) and marks the recovery refunded in our DB.'}
        </p>

        <label className="flex items-start gap-2 mb-3 text-sm text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
          />
          <span>This subscriber re-cancelled within 14 days OR support has approved an out-of-window refund.</span>
        </label>

        <label className="block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5">
          Type REFUND to confirm
        </label>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
          placeholder="REFUND"
          autoFocus
        />

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-sm mb-4">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!ready}
            className={
              ready
                ? 'bg-[#0f172a] text-white hover:bg-[#1e293b] rounded-full px-5 py-2 text-sm font-medium'
                : 'bg-slate-200 text-slate-400 rounded-full px-5 py-2 text-sm font-medium cursor-not-allowed'
            }
          >
            {submitting ? 'Refunding…' : 'Refund'}
          </button>
        </div>
      </div>
    </div>
  )
}

function MrrTrend({ points }: { points: MrrPoint[] }) {
  // Pivot to one row per week with strong/weak/organic columns.
  const byWeek = new Map<string, { strong: number; weak: number; organic: number }>()
  for (const p of points) {
    const cur = byWeek.get(p.week) ?? { strong: 0, weak: 0, organic: 0 }
    if (p.attributionType === 'strong') cur.strong += p.cents
    else if (p.attributionType === 'weak') cur.weak += p.cents
    else cur.organic += p.cents
    byWeek.set(p.week, cur)
  }
  const weeks = Array.from(byWeek.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  if (weeks.length === 0) {
    return <div className="text-sm text-slate-400 italic">No recoveries in the last 13 weeks.</div>
  }
  const max = Math.max(1, ...weeks.map(([, v]) => v.strong + v.weak + v.organic))
  return (
    <div>
      <div className="flex items-end gap-1 h-32">
        {weeks.map(([week, v]) => {
          const total = v.strong + v.weak + v.organic
          const h = (total / max) * 100
          return (
            <div
              key={week}
              className="flex-1 flex flex-col-reverse"
              title={`Week of ${week}: $${(total / 100).toFixed(2)} total · strong $${(v.strong / 100).toFixed(2)} · weak $${(v.weak / 100).toFixed(2)} · organic $${(v.organic / 100).toFixed(2)}`}
              style={{ height: `${Math.max(h, 2)}%` }}
            >
              <div className="bg-green-400" style={{ flexGrow: v.strong || 0.001 }} />
              <div className="bg-amber-300" style={{ flexGrow: v.weak || 0.001 }} />
              <div className="bg-slate-200" style={{ flexGrow: v.organic || 0.001 }} />
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-slate-600 mt-2">
        <div className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-400" /> Strong (billable)</div>
        <div className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-300" /> Weak</div>
        <div className="flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-slate-200" /> Organic</div>
      </div>
    </div>
  )
}

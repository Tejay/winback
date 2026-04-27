'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

interface Breakdown {
  period: string
  paid: number
  pending: number
  failed: number
  skippedNoObligations: number
  skippedNoCard: number
}

interface FailedRun {
  id: string
  customerId: string
  periodYyyymm: string
  amountCents: number
  stripeInvoiceId: string | null
  createdAt: string
  productName: string | null
  customerEmail: string | null
}

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

interface MrrPoint {
  week: string
  attributionType: string
  cents: number
  n: number
}

interface Payload {
  breakdown: Breakdown
  failed: FailedRun[]
  outstanding: OutstandingRow[]
  mrrTrend: MrrPoint[]
}

export function BillingClient() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [retryBusy, setRetryBusy] = useState<string | null>(null)
  const [retryMsg, setRetryMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/billing', { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load')
      setData(json)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function retry(runId: string) {
    setRetryBusy(runId)
    setRetryMsg(null)
    try {
      const res = await fetch('/api/admin/actions/billing-retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Retry failed')
      setRetryMsg(`✓ Retry: ${json.outcome}${json.stripeInvoiceId ? ` · invoice ${json.stripeInvoiceId}` : ''}`)
      await load()
    } catch (e) {
      setRetryMsg(`✗ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setRetryBusy(null)
    }
  }

  if (loading && !data) return <p className="text-sm text-slate-500">Loading…</p>
  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
        <strong>Failed to load.</strong> {error}
      </div>
    )
  }
  if (!data) return null

  const totalOutstandingCents = data.outstanding.reduce((a, b) => a + b.feeCents, 0)
  const totalOutstandingMrr = data.outstanding.reduce((a, b) => a + b.planMrrCents, 0)

  return (
    <div className="space-y-8">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          Billing operations
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Billing.</h1>
      </header>

      {retryMsg && (
        <div className={`text-sm rounded-xl px-3 py-2 ${
          retryMsg.startsWith('✓')
            ? 'bg-green-50 text-green-800 border border-green-200'
            : 'bg-red-50 text-red-800 border border-red-200'
        }`}>{retryMsg}</div>
      )}

      {/* Block A — current period status breakdown */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Current period · {data.breakdown.period}
        </div>
        <BreakdownBar breakdown={data.breakdown} />
      </section>

      {/* Block B — failed invoices */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Failed invoices (last 90 days)
        </div>
        {data.failed.length === 0 ? (
          <div className="text-sm text-slate-400 italic">No failed runs in the last 90 days.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              <tr>
                <th className="text-left py-2">Customer</th>
                <th className="text-left py-2">Period</th>
                <th className="text-right py-2">Amount</th>
                <th className="text-left py-2">When</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.failed.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="py-2">
                    <Link href={`/admin/customers/${r.customerId}`} className="text-blue-600 hover:underline">
                      {r.productName ?? r.customerEmail ?? r.customerId.slice(0, 8)}
                    </Link>
                    {r.customerEmail && r.productName && (
                      <div className="text-xs text-slate-400">{r.customerEmail}</div>
                    )}
                  </td>
                  <td className="py-2 font-mono text-xs">{r.periodYyyymm}</td>
                  <td className="py-2 text-right tabular-nums">${(r.amountCents / 100).toFixed(2)}</td>
                  <td className="py-2 text-xs text-slate-500">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => retry(r.id)}
                      disabled={retryBusy !== null}
                      className="text-xs bg-[#0f172a] text-white rounded-full px-3 py-1.5 hover:bg-[#1e293b] disabled:opacity-50"
                    >
                      {retryBusy === r.id ? '…' : 'Retry'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Block C — outstanding obligations */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Outstanding obligations
          </div>
          {totalOutstandingCents > 0 && (
            <div className="text-sm text-slate-700">
              <strong>${(totalOutstandingCents / 100).toFixed(2)}</strong> uncollected
              <span className="text-slate-400"> · across {data.outstanding.length} recoveries · ${(totalOutstandingMrr / 100).toFixed(2)} MRR</span>
            </div>
          )}
        </div>
        {data.outstanding.length === 0 ? (
          <div className="text-sm text-slate-400 italic">No outstanding obligations — every strong recovery is in a paid run.</div>
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
              {data.outstanding.map((r) => (
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

      {/* Block D — weekly MRR trend */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          MRR recovered (last 13 weeks)
        </div>
        <MrrTrend points={data.mrrTrend} />
      </section>
    </div>
  )
}

function BreakdownBar({ breakdown }: { breakdown: Breakdown }) {
  const total = breakdown.paid + breakdown.pending + breakdown.failed + breakdown.skippedNoObligations + breakdown.skippedNoCard
  if (total === 0) {
    return <div className="text-sm text-slate-400 italic">No billing runs yet for this period.</div>
  }
  const segs: Array<{ key: string; label: string; n: number; color: string }> = [
    { key: 'paid',     label: 'Paid',     n: breakdown.paid,                color: 'bg-green-400 text-green-900' },
    { key: 'pending',  label: 'Pending',  n: breakdown.pending,             color: 'bg-amber-400 text-amber-900' },
    { key: 'failed',   label: 'Failed',   n: breakdown.failed,              color: 'bg-red-400 text-red-900' },
    { key: 'skippedO', label: 'No oblig', n: breakdown.skippedNoObligations,color: 'bg-slate-300 text-slate-700' },
    { key: 'skippedC', label: 'No card',  n: breakdown.skippedNoCard,       color: 'bg-slate-300 text-slate-700' },
  ]
  return (
    <div className="space-y-3">
      <div className="flex h-8 rounded-lg overflow-hidden bg-slate-100">
        {segs.map((s) => {
          if (s.n === 0) return null
          return (
            <div
              key={s.key}
              className={`${s.color} flex items-center justify-center text-xs font-semibold`}
              style={{ width: `${(s.n / total) * 100}%` }}
              title={`${s.label}: ${s.n}`}
            >
              {(s.n / total) * 100 > 10 ? `${s.label} ${s.n}` : s.n}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-slate-600">
        {segs.map((s) => (
          <div key={s.key} className="flex items-center gap-1.5">
            <span className={`inline-block w-2.5 h-2.5 rounded-sm ${s.color.split(' ')[0]}`} />
            <span>{s.label}: <strong>{s.n}</strong></span>
          </div>
        ))}
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

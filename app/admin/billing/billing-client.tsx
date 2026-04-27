'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

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

interface MrrPoint {
  week: string
  attributionType: string
  cents: number
  n: number
}

interface Payload {
  outstanding: OutstandingRow[]
  mrrTrend: MrrPoint[]
}

export function BillingClient() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

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
        <p className="text-sm text-slate-500 mt-1">
          Stripe Subscriptions drive monthly billing automatically; this page tracks
          win-back fees that are queued (waiting on a card) and the weekly recovery trend.
        </p>
      </header>

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
        {data.outstanding.length === 0 ? (
          <div className="text-sm text-slate-400 italic">No queued win-back fees — every strong recovery has been charged.</div>
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

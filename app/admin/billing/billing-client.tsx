'use client'

import { useEffect, useState } from 'react'

/**
 * /admin/billing — drastically slimmed by the billing rewrite. The
 * outstanding / charged perf-fee tables are gone (perf fees deleted).
 * What's left is the weekly MRR-recovered trend, still useful as an
 * operational pulse. Tier-distribution and tier-transition views can be
 * added here later if/when admin asks for them.
 */

interface MrrTrendRow {
  week: string
  attributionType: string
  cents: number
  n: number
}

interface BillingData {
  mrrTrend: MrrTrendRow[]
  stripeMode: 'test' | 'live'
}

export default function BillingClient() {
  const [data, setData] = useState<BillingData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/admin/billing')
      .then((r) => r.json())
      .then((payload) => {
        if ('error' in payload) {
          setError(payload.error)
        } else {
          setData(payload as BillingData)
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  if (error) {
    return <div className="p-6 text-rose-600">{error}</div>
  }
  if (!data) {
    return <div className="p-6 text-slate-500">Loading…</div>
  }

  const totalByWeek = new Map<string, number>()
  for (const r of data.mrrTrend) {
    totalByWeek.set(r.week, (totalByWeek.get(r.week) ?? 0) + r.cents)
  }
  const weekKeys = Array.from(totalByWeek.keys()).sort()

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Billing — MRR recovered (13 weeks)</h1>
        <p className="text-sm text-slate-500">
          Mode: {data.stripeMode}. Per-recovery perf-fee tables retired in the
          billing rewrite — see customer-detail for tier and platform
          subscription state.
        </p>
      </header>

      <table className="w-full text-sm">
        <thead className="border-b text-left">
          <tr>
            <th className="py-2">Week</th>
            <th className="py-2 text-right">MRR recovered (USD)</th>
            <th className="py-2 text-right">Recoveries</th>
          </tr>
        </thead>
        <tbody>
          {weekKeys.map((week) => {
            const cents = totalByWeek.get(week) ?? 0
            const n = data.mrrTrend
              .filter((r) => r.week === week)
              .reduce((s, r) => s + r.n, 0)
            return (
              <tr key={week} className="border-b">
                <td className="py-2">{week}</td>
                <td className="py-2 text-right tabular-nums">
                  ${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </td>
                <td className="py-2 text-right tabular-nums">{n}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

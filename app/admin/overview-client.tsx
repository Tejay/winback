'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface OverviewRollup {
  today: {
    classifications: number
    emailsSent: number
    replies: number
    recoveries: { strong: number; weak: number; organic: number; total: number }
    errors: number
  }
  sparklines: {
    emailsSent: number[]
    replies: number[]
    recoveries: number[]
    errors: number[]
  }
  totals: {
    activeCustomers: number
    paidCustomers: number
    trialCustomers: number
    subscribersEver: number
  }
  redLights: Array<{ metric: string; today: number; median7d: number }>
}

export function OverviewClient() {
  const [data, setData] = useState<OverviewRollup | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/admin/overview', { cache: 'no-store' })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(json.error ?? 'Failed to load overview')
        setData(json)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const t = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  if (loading && !data) {
    return <p className="text-sm text-slate-500">Loading…</p>
  }
  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
        <strong>Failed to load overview.</strong> {error}
      </div>
    )
  }
  if (!data) return null

  const t = data.today
  const recs = `${t.recoveries.strong}S / ${t.recoveries.weak}W / ${t.recoveries.organic}O`

  return (
    <div className="space-y-8">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          Today
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Overview.</h1>
        <p className="text-sm text-slate-500">Live counters refresh every 30 seconds.</p>
      </header>

      {data.redLights.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm space-y-1">
          <div className="font-semibold text-red-900 uppercase text-xs tracking-wider">
            Red lights
          </div>
          {data.redLights.map((rl) => (
            <div key={rl.metric} className="text-red-800 flex items-center gap-2">
              <span>⚠</span>
              <span>
                <strong>{rl.metric}</strong> today is {rl.today} (
                {rl.median7d > 0 ? `>3× 7-day median of ${rl.median7d}` : 'no recent baseline'}
                )
              </span>
              <Link
                href={`/admin/events?name=${rl.metric === 'errors' ? 'oauth_error' : 'email_replied'}`}
                className="ml-auto text-xs underline"
              >
                investigate →
              </Link>
            </div>
          ))}
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Counter label="Classifications" value={t.classifications} spark={data.sparklines.emailsSent} />
        <Counter label="Emails sent"     value={t.emailsSent}      spark={data.sparklines.emailsSent} />
        <Counter label="Replies"         value={t.replies}         spark={data.sparklines.replies} />
        <Counter label="Recoveries"      value={t.recoveries.total} sub={recs} spark={data.sparklines.recoveries} />
        <Counter label="Errors"          value={t.errors}          spark={data.sparklines.errors}
          tone={t.errors > 0 ? 'warn' : 'ok'} />
      </section>

      <section className="bg-white rounded-2xl border border-slate-200 p-5 text-sm">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">
          Platform totals
        </div>
        <div className="text-slate-900">
          <strong>{data.totals.activeCustomers}</strong> active customers (
          {data.totals.paidCustomers} paid, {data.totals.trialCustomers} trial)
          &middot; <strong>{data.totals.subscribersEver.toLocaleString()}</strong> subscribers
          processed all-time
        </div>
      </section>
    </div>
  )
}

function Counter({
  label,
  value,
  sub,
  spark,
  tone = 'ok',
}: {
  label: string
  value: number
  sub?: string
  spark: number[]
  tone?: 'ok' | 'warn'
}) {
  const max = Math.max(1, ...spark)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">
        {label}
      </div>
      <div className={`text-3xl font-bold ${tone === 'warn' ? 'text-red-600' : 'text-slate-900'}`}>
        {value.toLocaleString()}
      </div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
      <Sparkline values={spark} max={max} />
    </div>
  )
}

function Sparkline({ values, max }: { values: number[]; max: number }) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  return (
    <div className="font-mono text-blue-500 mt-3 leading-none text-[14px]">
      {values
        .map((v) => blocks[Math.min(blocks.length - 1, Math.floor((v / max) * (blocks.length - 1)))])
        .join('')}
    </div>
  )
}

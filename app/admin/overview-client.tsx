'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type ErrorSource =
  | 'oauth_error'
  | 'billing_invoice_failed'
  | 'reactivate_failed'
  | 'email_send_failed'
  | 'classifier_failed'
  | 'webhook_signature_invalid'

interface OverviewRollup {
  today: {
    classifications: number
    emailsSent: number
    /** Spec 26 — replaces `replies` (was a weak signal). */
    handoffs: number
    recoveries: { strong: number; weak: number; organic: number; total: number }
    /** Spec 26 — strong (billable) MRR recovered today, in cents. */
    mrrCents: number
    errors: {
      total: number
      bySource: Record<ErrorSource, number>
    }
  }
  sparklines: {
    emailsSent: number[]
    handoffs: number[]
    recoveries: number[]
    mrrCents: number[]
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

/** Display labels for each error source — used by the breakdown row in the Errors tile. */
const ERROR_SOURCE_LABELS: Record<ErrorSource, string> = {
  oauth_error:                'OAuth',
  billing_invoice_failed:     'Billing',
  reactivate_failed:          'Reactivate',
  email_send_failed:          'Send',
  classifier_failed:          'AI',
  webhook_signature_invalid:  'Webhook',
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
  const mrrDollars = `$${(t.mrrCents / 100).toFixed(2)}`

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
                href={
                  rl.metric === 'errors'
                    ? '/admin/events?name=oauth_error'
                    : rl.metric === 'handoffs'
                      ? '/admin/events?name=founder_handoff_triggered'
                      : '/admin/events'
                }
                className="ml-auto text-xs underline"
              >
                investigate →
              </Link>
            </div>
          ))}
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Counter label="Classifications" value={t.classifications} spark={data.sparklines.emailsSent} />
        <Counter label="Emails sent"     value={t.emailsSent}      spark={data.sparklines.emailsSent} />
        <Counter label="Hand-offs"       value={t.handoffs}        spark={data.sparklines.handoffs} />
        <Counter label="Recoveries"      value={t.recoveries.total} sub={recs} spark={data.sparklines.recoveries} />
        <Counter
          label="$ recovered (strong)"
          /* render dollars in the value slot, not the int — different display. */
          customValue={mrrDollars}
          value={t.mrrCents}
          spark={data.sparklines.mrrCents}
          tone={t.mrrCents > 0 ? 'pop' : 'ok'}
        />
        <ErrorsCounter today={t.errors} spark={data.sparklines.errors} />
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
  customValue,
  sub,
  spark,
  tone = 'ok',
}: {
  label: string
  value: number
  /** When set, displayed instead of value.toLocaleString() (e.g. dollar formatting). */
  customValue?: string
  sub?: string
  spark: number[]
  tone?: 'ok' | 'warn' | 'pop'
}) {
  const max = Math.max(1, ...spark)
  const toneClass =
    tone === 'warn' ? 'text-red-600'
    : tone === 'pop' ? 'text-green-600'
    : 'text-slate-900'
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">
        {label}
      </div>
      <div className={`text-3xl font-bold ${toneClass}`}>
        {customValue ?? value.toLocaleString()}
      </div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
      <Sparkline values={spark} max={max} />
    </div>
  )
}

/**
 * Spec 26 — Errors tile with per-source breakdown for triage.
 *
 * Top: total + sparkline. Bottom: small grid of per-source pills, each
 * a link to /admin/events filtered by that source. Renders even when
 * total is 0 so the tile shape doesn't shift on quiet days.
 */
function ErrorsCounter({
  today,
  spark,
}: {
  today: { total: number; bySource: Record<ErrorSource, number> }
  spark: number[]
}) {
  const max = Math.max(1, ...spark)
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">
        Errors
      </div>
      <div className={`text-3xl font-bold ${today.total > 0 ? 'text-red-600' : 'text-slate-900'}`}>
        {today.total.toLocaleString()}
      </div>
      <Sparkline values={spark} max={max} />
      <div className="grid grid-cols-3 gap-1 mt-3 text-[10px]">
        {(Object.keys(ERROR_SOURCE_LABELS) as ErrorSource[]).map((src) => {
          const n = today.bySource[src] ?? 0
          return (
            <Link
              key={src}
              href={`/admin/events?name=${src}`}
              className={`flex items-center justify-between px-1.5 py-0.5 rounded ${
                n > 0 ? 'bg-red-50 text-red-700' : 'text-slate-400 hover:bg-slate-50'
              }`}
              title={`${ERROR_SOURCE_LABELS[src]}: ${n} today`}
            >
              <span className="truncate">{ERROR_SOURCE_LABELS[src]}</span>
              <span className="font-semibold tabular-nums">{n}</span>
            </Link>
          )
        })}
      </div>
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

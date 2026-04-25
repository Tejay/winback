'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface DayBucket { day: string; n: number }

interface TierBucket { day: string; tier: number; n: number }

interface HandoffAuditRow {
  id: string
  name: string | null
  email: string | null
  handoffReasoning: string | null
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
  mrrCents: number
  cancellationReason: string | null
  founderHandoffAt: string | null
  productName: string | null
  customerEmail: string | null
}

interface AutoLostAuditRow {
  id: string
  createdAt: string
  customerId: string | null
  customerEmail: string | null
  productName: string | null
  properties: Record<string, unknown>
}

interface Payload {
  handoffs: DayBucket[]
  autoLost: DayBucket[]
  likelihood: { high: number; medium: number; low: number; total: number }
  tier: TierBucket[]
  recentHandoffs: HandoffAuditRow[]
  recentAutoLost: AutoLostAuditRow[]
}

export function AiQualityClient() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/admin/ai-quality', { cache: 'no-store' })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(json.error ?? 'Failed to load')
        setData(json)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
  }, [])

  if (loading && !data) return <p className="text-sm text-slate-500">Loading…</p>
  if (error && !data) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm">
        <strong>Failed to load.</strong> {error}
      </div>
    )
  }
  if (!data) return null

  const handoffsTotal = data.handoffs.reduce((a, b) => a + b.n, 0)
  const autoLostTotal = data.autoLost.reduce((a, b) => a + b.n, 0)
  const handoffsMax   = Math.max(1, ...data.handoffs.map((b) => b.n))
  const autoLostMax   = Math.max(1, ...data.autoLost.map((b) => b.n))

  return (
    <div className="space-y-8">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          AI quality
        </div>
        <h1 className="text-3xl font-bold text-slate-900">AI quality.</h1>
        <p className="text-sm text-slate-500 max-w-2xl">
          Catches classifier drift before founders notice. Spot-read the audit blocks weekly.
        </p>
      </header>

      {/* Block A — handoff + auto-lost trends paired */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          30-day trends
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <TrendBlock
            title="Hand-offs triggered"
            total={handoffsTotal}
            buckets={data.handoffs}
            max={handoffsMax}
            tone="amber"
            hint="Sustained spike = prompt regression escalating too eagerly. Flatline near zero = AI not escalating high-value cases (suspicious)."
          />
          <TrendBlock
            title="Subscribers auto-lost"
            total={autoLostTotal}
            buckets={data.autoLost}
            max={autoLostMax}
            tone="slate"
            hint="If auto-lost climbs while handoffs flatline, AI is failing closed in the bad way."
          />
        </div>
      </section>

      {/* Block B — recovery likelihood histogram */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Recovery likelihood distribution (last 30 days)
        </div>
        <LikelihoodHistogram dist={data.likelihood} />
        <p className="text-xs text-slate-500 mt-3 max-w-2xl">
          Healthy range is roughly 10–20% high / 30–40% medium / 40–60% low.
          Sudden majority-high = model became overly optimistic.
          Majority-low = it gave up on everyone.
        </p>
      </section>

      {/* Block C — tier distribution */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Tier distribution (last 30 days)
        </div>
        <TierTable buckets={data.tier} />
        <p className="text-xs text-slate-500 mt-3 max-w-2xl">
          A sudden Tier-4 surge = classifier started suppressing things it shouldn't (silent failure after a prompt change). Tier-1 climbing = more actionable reasons (good).
        </p>
      </section>

      {/* Block D — handoff audit */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Last 50 hand-off reasonings (audit sample)
        </div>
        <p className="text-xs text-slate-500 mb-3 max-w-2xl">
          Spot-read 10 a week. If you find 3 you'd disagree with, the prompt needs work.
        </p>
        <div className="space-y-2 max-h-[28rem] overflow-y-auto">
          {data.recentHandoffs.length === 0
            ? <div className="text-sm text-slate-400 italic">No hand-offs on record yet.</div>
            : data.recentHandoffs.map((r) => <HandoffAuditCard key={r.id} row={r} />)}
        </div>
      </section>

      {/* Block E — auto-lost audit */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Last 50 silent closes (cases the AI gave up on)
        </div>
        <p className="text-xs text-slate-500 mb-3 max-w-2xl">
          Read these for false negatives. If you'd have wanted any of them escalated, the prompt is too aggressive about closing out.
        </p>
        <div className="space-y-2 max-h-[28rem] overflow-y-auto">
          {data.recentAutoLost.length === 0
            ? <div className="text-sm text-slate-400 italic">No auto-lost subscribers yet.</div>
            : data.recentAutoLost.map((r) => <AutoLostAuditCard key={r.id} row={r} />)}
        </div>
      </section>
    </div>
  )
}

function TrendBlock({
  title,
  total,
  buckets,
  max,
  tone,
  hint,
}: {
  title: string
  total: number
  buckets: DayBucket[]
  max: number
  tone: 'amber' | 'slate'
  hint: string
}) {
  const color = tone === 'amber' ? 'text-amber-600' : 'text-slate-600'
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-sm font-semibold text-slate-900">{title}</div>
        <div className={`text-2xl font-bold ${color}`}>{total.toLocaleString()}</div>
      </div>
      <div className="flex items-end gap-0.5 h-16">
        {buckets.map((b) => {
          const h = Math.round((b.n / max) * 100)
          return (
            <div
              key={b.day}
              title={`${b.day}: ${b.n}`}
              className={`flex-1 ${tone === 'amber' ? 'bg-amber-300' : 'bg-slate-300'} rounded-t-sm`}
              style={{ height: b.n > 0 ? `${Math.max(h, 4)}%` : '1px' }}
            />
          )
        })}
      </div>
      <div className="text-xs text-slate-400 mt-1">{buckets.length}d window</div>
      <p className="text-xs text-slate-500 mt-2">{hint}</p>
    </div>
  )
}

function LikelihoodHistogram({ dist }: { dist: { high: number; medium: number; low: number; total: number } }) {
  const total = Math.max(1, dist.total)
  const items: Array<{ key: 'high' | 'medium' | 'low'; n: number; pct: number; color: string; label: string }> = [
    { key: 'high',   n: dist.high,   pct: (dist.high   / total) * 100, color: 'bg-green-400 text-green-900',  label: 'High' },
    { key: 'medium', n: dist.medium, pct: (dist.medium / total) * 100, color: 'bg-amber-400 text-amber-900',  label: 'Medium' },
    { key: 'low',    n: dist.low,    pct: (dist.low    / total) * 100, color: 'bg-slate-300 text-slate-800',  label: 'Low' },
  ]
  if (dist.total === 0) {
    return <div className="text-sm text-slate-400 italic">No classifications in this window.</div>
  }
  return (
    <div className="space-y-2">
      {items.map((it) => (
        <div key={it.key} className="flex items-center gap-3">
          <div className="w-16 text-xs font-semibold text-slate-700">{it.label}</div>
          <div className="flex-1 h-6 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full ${it.color} flex items-center justify-end pr-2 text-xs font-medium`}
              style={{ width: `${Math.max(it.pct, it.n > 0 ? 4 : 0)}%` }}
            >
              {it.n > 0 && `${it.n} (${it.pct.toFixed(0)}%)`}
            </div>
          </div>
        </div>
      ))}
      <div className="text-xs text-slate-400 mt-1">{dist.total.toLocaleString()} classifications total</div>
    </div>
  )
}

function TierTable({ buckets }: { buckets: TierBucket[] }) {
  // Aggregate to tier totals + tier-by-week shape.
  const totals = [1, 2, 3, 4].map((tier) => ({
    tier,
    n: buckets.filter((b) => b.tier === tier).reduce((acc, b) => acc + b.n, 0),
  }))
  const grandTotal = totals.reduce((a, b) => a + b.n, 0) || 1
  return (
    <div className="space-y-2">
      {totals.map((t) => (
        <div key={t.tier} className="flex items-center gap-3">
          <div className="w-16 text-xs font-semibold text-slate-700">Tier {t.tier}</div>
          <div className="flex-1 h-6 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full ${tierColor(t.tier)} flex items-center justify-end pr-2 text-xs font-medium`}
              style={{ width: `${Math.max((t.n / grandTotal) * 100, t.n > 0 ? 4 : 0)}%` }}
            >
              {t.n > 0 && `${t.n} (${((t.n / grandTotal) * 100).toFixed(0)}%)`}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function tierColor(tier: number): string {
  return tier === 1 ? 'bg-green-300 text-green-900'
    : tier === 2 ? 'bg-blue-300 text-blue-900'
    : tier === 3 ? 'bg-amber-300 text-amber-900'
    : 'bg-slate-300 text-slate-800'
}

function HandoffAuditCard({ row }: { row: HandoffAuditRow }) {
  return (
    <div className="border border-slate-100 rounded-lg p-3 hover:bg-slate-50">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm">
          <div className="font-medium text-slate-900">{row.name ?? '(no name)'} <span className="text-slate-400 font-normal">· {row.email}</span></div>
          <div className="text-xs text-slate-500 mt-0.5">
            on{' '}
            <span className="text-slate-700">{row.productName ?? row.customerEmail ?? '?'}</span>
            {' · '}
            ${(row.mrrCents / 100).toFixed(2)}/mo
            {row.founderHandoffAt && <> · {new Date(row.founderHandoffAt).toLocaleDateString()}</>}
          </div>
        </div>
        {row.recoveryLikelihood && (
          <span className={`text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${
            row.recoveryLikelihood === 'high'   ? 'bg-green-50 text-green-700 border-green-200' :
            row.recoveryLikelihood === 'medium' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                                   'bg-slate-100 text-slate-500 border-slate-200'
          }`}>
            recovery: {row.recoveryLikelihood}
          </span>
        )}
      </div>
      {row.cancellationReason && (
        <div className="text-xs text-slate-600 italic mt-1">"{row.cancellationReason}"</div>
      )}
      {row.handoffReasoning && (
        <div className="text-xs text-slate-700 italic bg-slate-50 rounded p-2 mt-2">
          AI: "{row.handoffReasoning}"
        </div>
      )}
      <Link
        href={`/admin/subscribers?email=${encodeURIComponent(row.email ?? '')}`}
        className="inline-block text-xs text-blue-600 hover:underline mt-2"
      >
        View full thread →
      </Link>
    </div>
  )
}

function AutoLostAuditCard({ row }: { row: AutoLostAuditRow }) {
  const reasoning = typeof row.properties.reasoningExcerpt === 'string'
    ? row.properties.reasoningExcerpt
    : null
  const likelihood = typeof row.properties.recoveryLikelihood === 'string'
    ? row.properties.recoveryLikelihood
    : null
  return (
    <div className="border border-slate-100 rounded-lg p-3 hover:bg-slate-50">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm">
          <div className="font-medium text-slate-900">{row.productName ?? row.customerEmail ?? '(unknown customer)'}</div>
          <div className="text-xs text-slate-500 mt-0.5">{new Date(row.createdAt).toLocaleString()}</div>
        </div>
        {likelihood && (
          <span className="text-xs px-2 py-0.5 rounded-full border whitespace-nowrap bg-slate-100 text-slate-500 border-slate-200">
            recovery: {likelihood}
          </span>
        )}
      </div>
      {reasoning && (
        <div className="text-xs text-slate-700 italic bg-slate-50 rounded p-2 mt-2">
          AI: "{reasoning}"
        </div>
      )}
    </div>
  )
}

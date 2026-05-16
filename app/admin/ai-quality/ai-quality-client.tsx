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

// Spec 78 Phase A — new payload pieces

interface DriftMetric {
  label: string
  last7d: number
  prior23d: number
  deltaPct: number | null
  flagged: boolean
  format: 'count' | 'rate_per_day' | 'percent' | 'decimal'
}

interface CategoryMixRow {
  category: string
  count30d: number
  pct30d: number
  pctShift7d: number
}

interface LowConfidenceRow {
  id: string
  classifiedAt: string | null
  name: string | null
  email: string | null
  tier: number | null
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
  confidence: number | null
  cancellationReason: string | null
  cancellationCategory: string | null
  productName: string | null
  customerEmail: string | null
}

interface Payload {
  // Legacy (Phase D removes)
  handoffs: DayBucket[]
  autoLost: DayBucket[]
  likelihood: { high: number; medium: number; low: number; total: number }
  tier: TierBucket[]
  recentHandoffs: HandoffAuditRow[]
  recentAutoLost: AutoLostAuditRow[]
  // Spec 78 Phase A
  drift: { metrics: DriftMetric[] }
  categoryMix: { rows: CategoryMixRow[]; total30d: number }
  lowConfidence: LowConfidenceRow[]
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

      <HowToRead />

      {/* Block 2 — Drift detection (replaces old Block A paired trends) */}
      <DriftBlock metrics={data.drift.metrics} />

      {/* Block 3 — Cancellation category mix (replaces old Block C tier distribution) */}
      <CategoryMixBlock data={data.categoryMix} />

      {/* Block B (legacy — Phase B will replace with the calibration table) */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Recovery likelihood distribution (last 30 days)
        </div>
        <LikelihoodHistogram dist={data.likelihood} />
        <p className="text-xs text-slate-500 italic mt-3 max-w-2xl">
          Phase B (coming) replaces this with an outcome-grounded calibration table —
          "did high-likelihood cases actually recover more than low ones?"
        </p>
      </section>

      {/* Block 6 — Low-confidence classifications (new) */}
      <LowConfidenceBlock rows={data.lowConfidence} />

      {/* Block D (legacy — Phase C will replace with smart-ranked handoff audit) */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Last 50 hand-off reasonings (audit sample)
        </div>
        <p className="text-xs text-slate-500 italic mb-3 max-w-2xl">
          Spot-read 10 a week. If you find 3 you'd disagree with, the prompt needs work.
          Phase C will rank these by miss-likelihood (MRR + engagement) so the 10 you read
          are the 10 most worth reading.
        </p>
        <div className="space-y-2 max-h-[28rem] overflow-y-auto">
          {data.recentHandoffs.length === 0
            ? <div className="text-sm text-slate-400 italic">No hand-offs on record yet.</div>
            : data.recentHandoffs.map((r) => <HandoffAuditCard key={r.id} row={r} />)}
        </div>
      </section>

      {/* Block E (legacy — Phase C will replace with smart-ranked auto-lost audit) */}
      <section className="bg-white rounded-2xl border border-slate-200 p-5">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
          Last 50 reply threads ended without escalation
        </div>
        <p className="text-xs text-slate-500 italic mb-3 max-w-2xl">
          Auto-lost only fires after 1-3 emails AND at least one subscriber reply, when
          the reply-thread budget runs out without the AI choosing to escalate. Read for
          missed escalations. Phase C will smart-rank these by MRR, reply count, and
          cancellation category — the cases most likely to be misses surface first.
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

// ===========================================================================
// Spec 78 Phase A blocks
// ===========================================================================

/**
 * Collapsible header explaining the weekly cadence and what each block
 * means. Closed by default — power users skip it; new viewers expand
 * once and absorb it.
 */
function HowToRead() {
  const [open, setOpen] = useState(false)
  return (
    <section className="bg-blue-50/40 border border-blue-100 rounded-2xl p-5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 text-sm font-semibold text-blue-900 hover:text-blue-700"
      >
        <span>{open ? '▼' : '▶'}</span>
        <span>How to read this dashboard (weekly cadence, ~15 min)</span>
      </button>
      {open && (
        <div className="mt-3 text-sm text-slate-700 space-y-2 max-w-3xl">
          <p>This dashboard catches classifier prompt drift before merchants notice. The classifier makes thousands of judgments per week — which subscribers to email, what tier to assign, whether to escalate to the founder, whether to give up on a reply thread. This dashboard surfaces <em>patterns</em> in those judgments.</p>
          <p><strong>Friday 15-minute walk:</strong></p>
          <ol className="list-decimal pl-5 space-y-1">
            <li>Glance at the <strong>drift block</strong> — anything flagged ⚠? Tier-4 share spiking = suppression bug. Confidence dropping = AI hedging.</li>
            <li>Glance at the <strong>category mix</strong> — anything spiking? A "Feature" or "Quality" surge is actionable.</li>
            <li>Spot-read the <strong>low-confidence classifications</strong> — these concentrate the AI's weak spots, far more useful than random.</li>
            <li>Spot-read the audit blocks — read for missed escalations.</li>
          </ol>
          <p>If anything looks off → the prompt is the suspect. Check what's changed in <code className="text-xs">src/winback/lib/classifier.ts</code> and roll back / iterate.</p>
        </div>
      )}
    </section>
  )
}

function DriftBlock({ metrics }: { metrics: DriftMetric[] }) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">
        Drift detection
      </div>
      <h2 className="text-lg font-semibold text-slate-900 mb-2">What changed this week?</h2>
      <p className="text-xs text-slate-500 italic mb-4 max-w-2xl">
        Last 7 days vs. the prior 23 days (rolling baseline). Prompt regressions show up
        here in days. Watch in particular: Tier-4 share spiking (suppression bug —
        silent failure), low-likelihood share rising (prompt got pessimistic),
        median confidence falling (AI hedging — leading indicator of misclassification).
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">
              <th className="text-left py-2 pr-4">Metric</th>
              <th className="text-right py-2 pr-4">Last 7d</th>
              <th className="text-right py-2 pr-4">Prior 23d</th>
              <th className="text-right py-2 pr-4">Δ</th>
              <th className="text-left py-2">Flag</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.label} className="border-b border-slate-50 last:border-b-0">
                <td className="py-2 pr-4 text-slate-800">{m.label}</td>
                <td className="py-2 pr-4 text-right tabular-nums font-medium text-slate-900">
                  {formatMetric(m.last7d, m.format)}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums text-slate-500">
                  {formatMetric(m.prior23d, m.format)}
                </td>
                <td className={`py-2 pr-4 text-right tabular-nums ${
                  m.deltaPct === null ? 'text-slate-400'
                  : m.flagged          ? 'text-amber-700 font-semibold'
                  : m.deltaPct > 0     ? 'text-slate-700'
                  :                       'text-slate-700'
                }`}>
                  {m.deltaPct === null
                    ? '—'
                    : `${m.deltaPct > 0 ? '+' : ''}${m.deltaPct}%`}
                </td>
                <td className="py-2">
                  {m.flagged && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                      ⚠ drift
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function formatMetric(v: number, format: DriftMetric['format']): string {
  if (!Number.isFinite(v)) return '—'
  switch (format) {
    case 'percent':       return `${v.toFixed(0)}%`
    case 'rate_per_day':  return v < 10 ? v.toFixed(1) : v.toFixed(0)
    case 'decimal':       return v.toFixed(2)
    case 'count':
    default:              return Math.round(v).toLocaleString()
  }
}

function CategoryMixBlock({ data }: { data: { rows: CategoryMixRow[]; total30d: number } }) {
  const { rows, total30d } = data
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">
        Category mix
      </div>
      <h2 className="text-lg font-semibold text-slate-900 mb-2">
        Cancellation category mix
        <span className="text-sm font-normal text-slate-400 ml-2">
          (last 30 days · n={total30d.toLocaleString()})
        </span>
      </h2>
      <p className="text-xs text-slate-500 italic mb-4 max-w-2xl">
        Tier tells us how the AI wrote the email. <strong>Category tells us what subscribers
        actually said.</strong> A "Feature" or "Quality" spike is actionable — those are
        complaints you can fix. A "Competitor" spike tells you which competitor and how
        often. The Δpp column compares the last 7 days against the prior 23.
      </p>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-400 italic">No categorised classifications yet.</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => {
            const shiftFlag = Math.abs(r.pctShift7d) >= 2.5
            const shiftStr = `${r.pctShift7d > 0 ? '+' : ''}${r.pctShift7d.toFixed(1)}pp`
            return (
              <div
                key={r.category}
                className="flex items-center gap-3 px-2 py-1.5 rounded"
              >
                <div className="w-24 text-sm font-medium text-slate-700">{r.category}</div>
                <div className="flex-1 h-5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${categoryColor(r.category)} flex items-center justify-end pr-2 text-xs font-medium`}
                    style={{ width: `${Math.max(r.pct30d, r.count30d > 0 ? 4 : 0)}%` }}
                  >
                    {r.count30d > 0 && (
                      <span className="text-white">{r.count30d} ({r.pct30d.toFixed(0)}%)</span>
                    )}
                  </div>
                </div>
                <div className={`w-20 text-right text-xs tabular-nums ${
                  shiftFlag ? (r.pctShift7d > 0 ? 'text-amber-700 font-semibold' : 'text-blue-700 font-semibold')
                            : 'text-slate-500'
                }`}>
                  {shiftFlag ? (r.pctShift7d > 0 ? '↑ ' : '↓ ') : ''}{shiftStr}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function categoryColor(category: string): string {
  switch (category) {
    case 'Competitor': return 'bg-purple-400'
    case 'Price':      return 'bg-amber-400'
    case 'Quality':    return 'bg-rose-400'
    case 'Unused':     return 'bg-slate-400'
    case 'Feature':    return 'bg-blue-400'
    case 'Other':      return 'bg-slate-300'
    default:           return 'bg-slate-300'
  }
}

function LowConfidenceBlock({ rows }: { rows: LowConfidenceRow[] }) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">
        Low-confidence audit
      </div>
      <h2 className="text-lg font-semibold text-slate-900 mb-2">
        Where the AI hedged
        <span className="text-sm font-normal text-slate-400 ml-2">(last 25 · confidence &lt; 0.4)</span>
      </h2>
      <p className="text-xs text-slate-500 italic mb-4 max-w-2xl">
        The classifier returns a self-reported <code className="text-xs">confidence</code> from
        0 to 1 on every classification. Below 0.4 means the AI <em>itself</em> flagged that
        it was hedging. These cases concentrate the prompt's weak spots better than reading
        random classifications — if 80% land on the same edge case (e.g. ambiguous "wasn't a
        fit" replies), that's where prompt iteration should focus.
      </p>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-400 italic">No low-confidence classifications in the window.</div>
      ) : (
        <div className="space-y-2 max-h-[28rem] overflow-y-auto">
          {rows.map((r) => <LowConfidenceCard key={r.id} row={r} />)}
        </div>
      )}
    </section>
  )
}

function LowConfidenceCard({ row }: { row: LowConfidenceRow }) {
  return (
    <div className="border border-slate-100 rounded-lg p-3 hover:bg-slate-50">
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm flex-1">
          <div className="font-medium text-slate-900">
            {row.name ?? '(no name)'}{' '}
            <span className="text-slate-400 font-normal">· {row.email ?? '—'}</span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            on <span className="text-slate-700">{row.productName ?? row.customerEmail ?? '?'}</span>
            {row.classifiedAt && <> · {new Date(row.classifiedAt).toLocaleDateString()}</>}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {row.tier !== null && (
            <span className="text-xs px-2 py-0.5 rounded-full border whitespace-nowrap bg-slate-50 text-slate-700 border-slate-200">
              T{row.tier}
            </span>
          )}
          {row.recoveryLikelihood && (
            <span className={`text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${
              row.recoveryLikelihood === 'high'   ? 'bg-green-50 text-green-700 border-green-200' :
              row.recoveryLikelihood === 'medium' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                                     'bg-slate-100 text-slate-500 border-slate-200'
            }`}>
              {row.recoveryLikelihood}
            </span>
          )}
          {row.confidence !== null && (
            <span className="text-xs px-2 py-0.5 rounded-full border whitespace-nowrap bg-rose-50 text-rose-700 border-rose-200 tabular-nums">
              conf {row.confidence.toFixed(2)}
            </span>
          )}
        </div>
      </div>
      {row.cancellationReason && (
        <div className="text-xs text-slate-600 italic mt-1.5">"{row.cancellationReason}"</div>
      )}
      {row.cancellationCategory && (
        <div className="text-xs text-slate-400 mt-1">category: {row.cancellationCategory}</div>
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

// ===========================================================================
// Legacy blocks (Phase B / Phase C will replace these)
// ===========================================================================

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

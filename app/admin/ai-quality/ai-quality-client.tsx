'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

// Spec 78 Phase C

interface RankedAuditRow {
  subscriberId: string
  customerId: string | null
  name: string | null
  email: string | null
  productName: string | null
  customerEmail: string | null
  mrrCents: number
  tenureDays: number | null
  cancellationReason: string | null
  cancellationCategory: string | null
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
  handoffReasoning: string | null
  replyCount: number
  billingPortalClicked: boolean
  interestScore: number
  occurredAt: string | null
}

interface RankedHandoffRow extends RankedAuditRow {
  founderHandoffAt: string | null
  founderHandoffResolvedAt: string | null
  resolutionState: 'open_fresh' | 'open_stale' | 'resolved_recovered' | 'resolved_lost'
  finalStatus: string | null
}

interface HandoffAuditSummary {
  windowDays: number
  total: number
  resolved: number
  recovered: number
  open: number
  stale: number
  recoveryPct: number
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

// Spec 78 Phase B

interface LikelihoodCalibrationRow {
  likelihood: 'high' | 'medium' | 'low'
  n: number
  recovered: number
  autoLost: number
  lostOther: number
  stillOpen: number
}

interface HandoffConversionRow {
  cohort: 'handoff' | 'non_handoff'
  n: number
  recovered: number
}

interface AutoLostReversalSummary {
  n: number
  reversed: number
  reversedSample: Array<{
    subscriberId: string
    name: string | null
    email: string | null
    recoveredAt: string | null
  }>
}

interface CalibrationCohort {
  startDate: string
  endDate: string
  total: number
  byLikelihood: LikelihoodCalibrationRow[]
  handoffConversion: HandoffConversionRow[]
  autoLostReversal: AutoLostReversalSummary
}

interface ReengagementMatchRate {
  windowDays: number
  eligible: number
  emailed: number
  expired: number
  pending: number
}

interface Payload {
  // Phase A
  drift: { metrics: DriftMetric[] }
  categoryMix: { rows: CategoryMixRow[]; total30d: number }
  lowConfidence: LowConfidenceRow[]
  // Phase B
  calibration: CalibrationCohort
  matchRate: ReengagementMatchRate
  // Phase C
  rankedAutoLost: RankedAuditRow[]
  rankedHandoffs: RankedHandoffRow[]
  handoffSummary: HandoffAuditSummary
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

      {/* Block 1 — Outcome-grounded calibration (replaces old Block B likelihood histogram) */}
      <CalibrationBlock cohort={data.calibration} />

      {/* Block 2 — Drift detection (replaces old Block A paired trends) */}
      <DriftBlock metrics={data.drift.metrics} />

      {/* Block 3 — Cancellation category mix (replaces old Block C tier distribution) */}
      <CategoryMixBlock data={data.categoryMix} />

      {/* Block 4 — Smart-ranked auto-lost audit (replaces legacy Block E) */}
      <RankedAuditBlock
        kind="auto_lost"
        rows={data.rankedAutoLost}
      />

      {/* Block 5 — Smart-ranked handoff audit + founder resolution (replaces legacy Block D) */}
      <RankedHandoffBlock
        rows={data.rankedHandoffs}
        summary={data.handoffSummary}
      />

      {/* Block 6 — Low-confidence classifications (new) */}
      <LowConfidenceBlock rows={data.lowConfidence} />

      {/* Block 7 — Re-engagement match rate */}
      <MatchRateBlock data={data.matchRate} />
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
                    className={`h-full ${categoryColor(r.category)} rounded-full`}
                    style={{ width: `${Math.max(r.pct30d, r.count30d > 0 ? 1.5 : 0)}%` }}
                  />
                </div>
                {/* Count label lives OUTSIDE the bar so small bars (like
                   "Switched" at 2%) remain readable. Bar is purely visual. */}
                <div className="w-20 text-right text-sm tabular-nums text-slate-900 font-medium">
                  {r.count30d > 0 ? <span>{r.count30d} <span className="text-slate-400 text-xs">({r.pct30d.toFixed(0)}%)</span></span> : <span className="text-slate-300">—</span>}
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

// Bar background colors paired so white text on them stays readable.
// Avoid the 300-400 range for yellows/grays — they make white text vanish.
function categoryColor(category: string): string {
  switch (category) {
    case 'Competitor': return 'bg-purple-500'
    case 'Price':      return 'bg-amber-600'
    case 'Quality':    return 'bg-rose-500'
    case 'Unused':     return 'bg-slate-500'
    case 'Feature':    return 'bg-blue-500'
    case 'Other':      return 'bg-slate-400'
    default:           return 'bg-slate-400'
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
// Spec 78 Phase B blocks
// ===========================================================================

function CalibrationBlock({ cohort }: { cohort: CalibrationCohort }) {
  const fmtDate = (s: string) => {
    try {
      return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    } catch { return '?' }
  }
  const cohortRange = `${fmtDate(cohort.startDate)} – ${fmtDate(cohort.endDate)}`

  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">
        Calibration
      </div>
      <h2 className="text-lg font-semibold text-slate-900 mb-2">
        Did the AI's calls hold up?
        <span className="text-sm font-normal text-slate-400 ml-2">
          (cohort: n={cohort.total.toLocaleString()} classified {cohortRange})
        </span>
      </h2>
      <p className="text-xs text-slate-500 italic mb-4 max-w-2xl">
        Looks at subscribers classified 30-90 days ago — long enough for outcomes to
        have resolved, recent enough to reflect current prompt behaviour. Three
        falsifiable claims: <strong>high likelihood should recover more than low</strong>
        (monotonic), <strong>handoffs should beat non-handoffs</strong>, <strong>auto-lost
        cases shouldn't reverse</strong> (any reversal = a confirmed false negative,
        read the case).
      </p>

      {cohort.total === 0 ? (
        <div className="text-sm text-slate-400 italic">
          Not enough data yet — the cohort window has no classifications. Calibration
          becomes meaningful once you've accumulated 30-90 day-old classifications.
        </div>
      ) : (
        <>
          {/* Table 1: Recovery by predicted likelihood */}
          <div className="mb-6">
            <div className="text-xs font-semibold text-slate-600 mb-2">
              Recovery rate by predicted likelihood
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">
                    <th className="text-left py-2 pr-4">Likelihood</th>
                    <th className="text-right py-2 pr-4">n</th>
                    <th className="text-right py-2 pr-4">Recovered</th>
                    <th className="text-right py-2 pr-4">Auto-lost</th>
                    <th className="text-right py-2 pr-4">Lost (other)</th>
                    <th className="text-right py-2">Still open</th>
                  </tr>
                </thead>
                <tbody>
                  {cohort.byLikelihood.map((r) => (
                    <tr key={r.likelihood} className="border-b border-slate-50 last:border-b-0">
                      <td className="py-2 pr-4">
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${
                          r.likelihood === 'high'   ? 'bg-green-50 text-green-700 border-green-200' :
                          r.likelihood === 'medium' ? 'bg-amber-50 text-amber-700 border-amber-200' :
                                                       'bg-slate-100 text-slate-500 border-slate-200'
                        }`}>
                          {r.likelihood}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-slate-900">{r.n}</td>
                      <td className="py-2 pr-4 text-right tabular-nums text-slate-900">
                        {r.n === 0 ? <span className="text-slate-300">—</span>
                                   : <span>{((r.recovered / r.n) * 100).toFixed(0)}% <span className="text-slate-400 text-xs">({r.recovered})</span></span>}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-slate-700">
                        {r.n === 0 ? <span className="text-slate-300">—</span>
                                   : <span>{((r.autoLost / r.n) * 100).toFixed(0)}% <span className="text-slate-400 text-xs">({r.autoLost})</span></span>}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-slate-700">
                        {r.n === 0 ? <span className="text-slate-300">—</span>
                                   : <span>{((r.lostOther / r.n) * 100).toFixed(0)}% <span className="text-slate-400 text-xs">({r.lostOther})</span></span>}
                      </td>
                      <td className="py-2 text-right tabular-nums text-slate-500">
                        {r.n === 0 ? <span className="text-slate-300">—</span>
                                   : <span>{((r.stillOpen / r.n) * 100).toFixed(0)}%</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CalibrationVerdict rows={cohort.byLikelihood} />
          </div>

          {/* Table 2: Handoff vs non-handoff conversion */}
          <div className="mb-6">
            <div className="text-xs font-semibold text-slate-600 mb-2">
              Handoff vs. non-handoff conversion
            </div>
            <HandoffConversionTable rows={cohort.handoffConversion} />
          </div>

          {/* Table 3: Auto-lost reversal */}
          <div>
            <div className="text-xs font-semibold text-slate-600 mb-2">
              Auto-lost reversal (false-negative rate)
            </div>
            <AutoLostReversal summary={cohort.autoLostReversal} />
          </div>
        </>
      )}
    </section>
  )
}

function CalibrationVerdict({ rows }: { rows: LikelihoodCalibrationRow[] }) {
  const insufficient = rows.some((r) => r.n < 5)
  if (insufficient) {
    return (
      <div className="mt-2 text-xs text-slate-500 italic">
        Some buckets have &lt; 5 cases — monotonicity check needs all three populated
        to be meaningful.
      </div>
    )
  }
  const rate = (r: LikelihoodCalibrationRow) => (r.n > 0 ? r.recovered / r.n : 0)
  const high = rate(rows.find((r) => r.likelihood === 'high')!)
  const med  = rate(rows.find((r) => r.likelihood === 'medium')!)
  const low  = rate(rows.find((r) => r.likelihood === 'low')!)
  const monotonic = high > med && med > low
  if (monotonic) {
    return (
      <div className="mt-2 text-xs text-green-700">
        ✓ Monotonic — high &gt; medium &gt; low recovery rates. The likelihood label is
        carrying real information.
      </div>
    )
  }
  return (
    <div className="mt-2 text-xs text-amber-700">
      ⚠ Not monotonic — high/medium/low recovery rates are not strictly decreasing. The
      likelihood label may be noise. Investigate prompt drift before trusting it for
      triage.
    </div>
  )
}

function HandoffConversionTable({ rows }: { rows: HandoffConversionRow[] }) {
  const handoff    = rows.find((r) => r.cohort === 'handoff')
  const nonHandoff = rows.find((r) => r.cohort === 'non_handoff')
  if (!handoff || !nonHandoff || handoff.n === 0 || nonHandoff.n === 0) {
    return (
      <div className="text-sm text-slate-400 italic">
        Insufficient data — need both handoff and non-handoff cohorts populated.
      </div>
    )
  }
  const hRate = (handoff.recovered    / handoff.n)    * 100
  const nRate = (nonHandoff.recovered / nonHandoff.n) * 100
  const lift  = hRate - nRate
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">
              <th className="text-left py-2 pr-4">Cohort</th>
              <th className="text-right py-2 pr-4">n</th>
              <th className="text-right py-2">Recovered</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-50">
              <td className="py-2 pr-4 text-slate-800">Handed off</td>
              <td className="py-2 pr-4 text-right tabular-nums">{handoff.n}</td>
              <td className="py-2 text-right tabular-nums font-medium">
                {hRate.toFixed(0)}% <span className="text-slate-400 text-xs">({handoff.recovered})</span>
              </td>
            </tr>
            <tr>
              <td className="py-2 pr-4 text-slate-800">Not handed off (baseline)</td>
              <td className="py-2 pr-4 text-right tabular-nums">{nonHandoff.n}</td>
              <td className="py-2 text-right tabular-nums">
                {nRate.toFixed(0)}% <span className="text-slate-400 text-xs">({nonHandoff.recovered})</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className={`mt-2 text-xs ${lift > 0 ? 'text-green-700' : 'text-amber-700'}`}>
        {lift > 0
          ? `✓ Handoffs +${lift.toFixed(0)}pp vs baseline — escalation is earning the founder's time.`
          : `⚠ Handoffs ${lift.toFixed(0)}pp vs baseline — handoff cohort isn't beating no-handoff. The AI may be escalating low-value cases, or the founder isn't getting to them.`}
      </div>
    </>
  )
}

function AutoLostReversal({ summary }: { summary: AutoLostReversalSummary }) {
  if (summary.n === 0) {
    return <div className="text-sm text-slate-400 italic">No auto-lost cases in this cohort.</div>
  }
  const pct = (summary.reversed / summary.n) * 100
  return (
    <>
      <div className="text-sm text-slate-700">
        {summary.n} auto-lost in this cohort, of which{' '}
        <span className={`font-semibold ${summary.reversed > 0 ? 'text-amber-700' : 'text-green-700'}`}>
          {summary.reversed} ({pct.toFixed(1)}%) later recovered
        </span>
        {summary.reversed > 0
          ? ' — confirmed false negatives. Read each one to find the pattern.'
          : ' — no measurable false negatives in this cohort.'}
      </div>
      {summary.reversedSample.length > 0 && (
        <div className="mt-3 space-y-1">
          {summary.reversedSample.map((s) => (
            <Link
              key={s.subscriberId}
              href={`/admin/subscribers/${s.subscriberId}`}
              className="block text-xs text-blue-600 hover:underline"
            >
              · {s.name ?? '(no name)'} {s.email && <span className="text-slate-400">· {s.email}</span>}
              {s.recoveredAt && <span className="text-slate-400"> · recovered {new Date(s.recoveredAt).toLocaleDateString()}</span>}
            </Link>
          ))}
        </div>
      )}
    </>
  )
}

function MatchRateBlock({ data }: { data: ReengagementMatchRate }) {
  const eligibleNonZero = Math.max(1, data.eligible)
  const emailedPct = (data.emailed / eligibleNonZero) * 100
  const expiredPct = (data.expired / eligibleNonZero) * 100
  const pendingPct = (data.pending / eligibleNonZero) * 100
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">
        Re-engagement
      </div>
      <h2 className="text-lg font-semibold text-slate-900 mb-2">
        Re-engagement match rate
        <span className="text-sm font-normal text-slate-400 ml-2">
          (last {data.windowDays} days · n={data.eligible.toLocaleString()})
        </span>
      </h2>
      <p className="text-xs text-slate-500 italic mb-4 max-w-2xl">
        The AI extracts a <code className="text-xs">triggerNeed</code> ("wants Zapier
        integration") when a cancellation has an addressable feature ask. Re-engagement
        matches these against shipping improvements. <strong>A low match rate has two
        causes worth distinguishing:</strong> (a) the AI's needs are too vague to LLM-match,
        or (b) the merchant isn't shipping improvements that address what subscribers
        asked for. Either way, actionable.
      </p>
      {data.eligible === 0 ? (
        <div className="text-sm text-slate-400 italic">
          No eligible subscribers in the window (none with triggerNeedConfidence='high').
        </div>
      ) : (
        <div className="space-y-2">
          <MatchRateRow label="Matched + emailed"        n={data.emailed} pct={emailedPct} color="bg-green-400" />
          <MatchRateRow label="Pending (in window)"      n={data.pending} pct={pendingPct} color="bg-amber-400" />
          <MatchRateRow label="Expired without a match"  n={data.expired} pct={expiredPct} color="bg-slate-300" />
        </div>
      )}
    </section>
  )
}

function MatchRateRow({ label, n, pct, color }: { label: string; n: number; pct: number; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-44 text-sm text-slate-700">{label}</div>
      <div className="flex-1 h-5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} flex items-center justify-end pr-2 text-xs font-medium text-white`}
          style={{ width: `${Math.max(pct, n > 0 ? 4 : 0)}%` }}
        >
          {n > 0 && `${n} (${pct.toFixed(0)}%)`}
        </div>
      </div>
    </div>
  )
}

// ===========================================================================
// Spec 78 Phase C — Smart-ranked audit blocks
// ===========================================================================

function RankedAuditBlock({
  kind,
  rows,
}: {
  kind: 'auto_lost'
  rows: RankedAuditRow[]
}) {
  // kind currently only 'auto_lost' (Block 5 has its own component
  // because of the resolution column + summary footer).
  void kind
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">
        Auto-lost audit
      </div>
      <h2 className="text-lg font-semibold text-slate-900 mb-2">
        Highest-stakes auto-lost cases
        <span className="text-sm font-normal text-slate-400 ml-2">
          (top {rows.length} by interest score)
        </span>
      </h2>
      <p className="text-xs text-slate-500 italic mb-4 max-w-2xl">
        Auto-lost only fires after 1-3 emails AND at least one reply, when the AI runs out
        of follow-up budget without escalating. These are cases where the AI engaged in
        conversation and decided not to hand off. <strong>Ranked top-to-bottom by
        miss-likelihood</strong> (+MRR, +reply count, +portal-click, +addressable category,
        −dead-text patterns). Read the top 5; if any feel like a missed escalation, the
        prompt is too conservative on the second-reply decision.
      </p>
      {rows.length === 0 ? (
        <div className="text-sm text-slate-400 italic">No auto-lost cases on record yet.</div>
      ) : (
        <div className="space-y-2 max-h-[40rem] overflow-y-auto">
          {rows.map((r) => <RankedAuditCard key={r.subscriberId} row={r} />)}
        </div>
      )}
    </section>
  )
}

function RankedHandoffBlock({
  rows,
  summary,
}: {
  rows: RankedHandoffRow[]
  summary: HandoffAuditSummary
}) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">
        Handoff audit
      </div>
      <h2 className="text-lg font-semibold text-slate-900 mb-2">
        Highest-stakes handoffs
        <span className="text-sm font-normal text-slate-400 ml-2">
          (top {rows.length} by interest score)
        </span>
      </h2>
      <p className="text-xs text-slate-500 italic mb-4 max-w-2xl">
        Each handoff costs founder inbox attention. The resolution column shows whether
        that attention is earning recoveries. <strong>Stale opens (≥7d)</strong> are
        either founder backlog or the AI escalating things that didn't warrant it. If
        most resolved handoffs are "lost" not "recovered," the AI is escalating cases
        that won't convert.
      </p>
      <HandoffSummaryFooter summary={summary} />
      {rows.length === 0 ? (
        <div className="text-sm text-slate-400 italic mt-4">No handoffs on record yet.</div>
      ) : (
        <div className="space-y-2 max-h-[40rem] overflow-y-auto mt-4">
          {rows.map((r) => <RankedHandoffCard key={r.subscriberId} row={r} />)}
        </div>
      )}
    </section>
  )
}

function HandoffSummaryFooter({ summary }: { summary: HandoffAuditSummary }) {
  return (
    <div className="text-xs text-slate-600 bg-slate-50 rounded-lg p-3 border border-slate-100">
      <strong>Last {summary.windowDays} days:</strong> {summary.total} handoffs ·{' '}
      {summary.resolved} resolved · {summary.recovered} recovered{' '}
      {summary.resolved > 0 && (
        <span className="text-slate-700">({summary.recoveryPct.toFixed(0)}% conversion)</span>
      )}{' '}
      · {summary.open} open
      {summary.stale > 0 && (
        <>
          {' · '}
          <span className="text-amber-700 font-semibold">{summary.stale} stale (≥7d)</span>
        </>
      )}
    </div>
  )
}

/**
 * Shared card body for Block 4 and Block 5. Lazy-fetches the full
 * inspector payload (emails + replies + events) on expand from
 * `/api/admin/subscribers/[id]` — no double-fetch.
 */
function RankedAuditCard({ row }: { row: RankedAuditRow }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border border-slate-100 rounded-lg p-3 hover:bg-slate-50">
      <CardHeader row={row} />
      <CardBody row={row} />
      <div className="flex items-center gap-3 mt-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-blue-600 hover:underline"
        >
          {expanded ? '↑ Hide conversation' : '↓ Show conversation'}
        </button>
        <Link
          href={`/admin/subscribers/${row.subscriberId}`}
          className="text-xs text-blue-600 hover:underline"
        >
          Full inspector →
        </Link>
      </div>
      {expanded && <ThreadExpansion subscriberId={row.subscriberId} />}
    </div>
  )
}

function RankedHandoffCard({ row }: { row: RankedHandoffRow }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border border-slate-100 rounded-lg p-3 hover:bg-slate-50">
      <CardHeader row={row} resolutionState={row.resolutionState} />
      <CardBody row={row} />
      <div className="flex items-center gap-3 mt-2">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-blue-600 hover:underline"
        >
          {expanded ? '↑ Hide conversation' : '↓ Show conversation'}
        </button>
        <Link
          href={`/admin/subscribers/${row.subscriberId}`}
          className="text-xs text-blue-600 hover:underline"
        >
          Full inspector →
        </Link>
      </div>
      {expanded && <ThreadExpansion subscriberId={row.subscriberId} />}
    </div>
  )
}

function CardHeader({
  row,
  resolutionState,
}: {
  row: RankedAuditRow
  resolutionState?: RankedHandoffRow['resolutionState']
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="text-sm flex-1">
        <div className="font-medium text-slate-900">
          {row.name ?? '(no name)'}{' '}
          <span className="text-slate-400 font-normal">· {row.email ?? '—'}</span>
        </div>
        <div className="text-xs text-slate-500 mt-0.5">
          on <span className="text-slate-700">{row.productName ?? row.customerEmail ?? '?'}</span>
          {' · '}${(row.mrrCents / 100).toFixed(2)}/mo
          {row.tenureDays !== null && <> · {row.tenureDays}d tenure</>}
          {row.occurredAt && <> · {new Date(row.occurredAt).toLocaleDateString()}</>}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-w-[40%]">
        {resolutionState && <ResolutionBadge state={resolutionState} />}
        {row.replyCount > 0 && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
            {row.replyCount} {row.replyCount === 1 ? 'reply' : 'replies'}
          </span>
        )}
        {row.billingPortalClicked && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200">
            portal clicked
          </span>
        )}
        {row.cancellationCategory && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-50 text-slate-700 border border-slate-200">
            {row.cancellationCategory}
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
        <span
          title="Internal interest_score — MRR/reply/portal/category bonuses minus dead-text penalties"
          className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200 tabular-nums"
        >
          score {row.interestScore}
        </span>
      </div>
    </div>
  )
}

function CardBody({ row }: { row: RankedAuditRow }) {
  return (
    <>
      {row.cancellationReason && (
        <div className="text-xs text-slate-600 italic mt-1.5">"{row.cancellationReason}"</div>
      )}
      {row.handoffReasoning && (
        <div className="text-xs text-slate-700 italic bg-slate-50 rounded p-2 mt-2">
          <span className="font-semibold not-italic text-slate-500">AI:</span> "{row.handoffReasoning}"
        </div>
      )}
    </>
  )
}

function ResolutionBadge({ state }: { state: RankedHandoffRow['resolutionState'] }) {
  switch (state) {
    case 'resolved_recovered':
      return <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">✓ recovered</span>
    case 'resolved_lost':
      return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">✗ resolved · lost</span>
    case 'open_stale':
      return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">⚠ open ≥7d</span>
    case 'open_fresh':
    default:
      return <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">⏳ open</span>
  }
}

/**
 * Lazy-fetched thread view. Hits the existing inspector endpoint
 * (`GET /api/admin/subscribers/[id]`) which already returns emails +
 * replies + outcome events in a single payload. Renders a compact
 * chronological thread. State is local to the card — collapse +
 * re-expand re-fetches; for normal use it's a one-time fetch since
 * the supervisor reads top to bottom.
 */
function ThreadExpansion({ subscriberId }: { subscriberId: string }) {
  const [data, setData] = useState<InspectorPayloadShape | null>(null)
  const [err, setErr]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/admin/subscribers/${subscriberId}`, { cache: 'no-store' })
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(json.error ?? 'Failed to load thread')
        setData(json)
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [subscriberId])

  if (loading) return <div className="text-xs text-slate-400 italic mt-3">Loading thread…</div>
  if (err)     return <div className="text-xs text-rose-600 mt-3">Failed to load: {err}</div>
  if (!data)   return null

  // Build a chronological turn list from emailsSent + replies.
  type Turn =
    | { kind: 'outbound'; at: string; type: string; subject: string | null; body: string | null }
    | { kind: 'reply';    at: string; from: string | null; body: string }
  const turns: Turn[] = []
  for (const e of data.emails ?? []) {
    turns.push({ kind: 'outbound', at: e.sentAt ?? '', type: e.type, subject: e.subject, body: e.bodyText })
  }
  for (const r of data.replies ?? []) {
    turns.push({ kind: 'reply', at: r.receivedAt ?? '', from: r.fromEmail, body: r.body })
  }
  turns.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  if (turns.length === 0) {
    return <div className="text-xs text-slate-500 italic mt-3">No emails or replies on record.</div>
  }

  return (
    <div className="mt-3 space-y-2 max-h-96 overflow-y-auto border-t border-slate-100 pt-3">
      {turns.map((t, i) => (
        <div
          key={i}
          className={`text-xs rounded p-2 ${
            t.kind === 'outbound' ? 'bg-blue-50/40 border border-blue-100'
                                  : 'bg-amber-50/40 border border-amber-100'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className={`font-semibold ${t.kind === 'outbound' ? 'text-blue-700' : 'text-amber-700'}`}>
              {t.kind === 'outbound' ? `→ ${t.type}` : `← reply${t.from ? ` from ${t.from}` : ''}`}
            </span>
            <span className="text-slate-400">{t.at ? new Date(t.at).toLocaleString() : ''}</span>
          </div>
          {t.kind === 'outbound' && t.subject && (
            <div className="font-medium text-slate-800 mb-1">{t.subject}</div>
          )}
          <div className="text-slate-700 whitespace-pre-wrap break-words">{t.body ?? '(no body)'}</div>
        </div>
      ))}
    </div>
  )
}

/**
 * Slim shape of `/api/admin/subscribers/[id]` — only the fields we
 * render. Full schema in `lib/admin/inspector-queries.ts::InspectorPayload`.
 */
interface InspectorPayloadShape {
  emails?: Array<{
    id: string
    type: string
    subject: string | null
    bodyText: string | null
    sentAt: string | null
  }>
  replies?: Array<{
    id: string
    body: string
    fromEmail: string | null
    receivedAt: string | null
  }>
}

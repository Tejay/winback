'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

/**
 * PR D — AI quality, rethought around what the classifier actually does
 * today: classify the cancellation, write the email copy, and label it for
 * re-engagement. (Founder handoff and auto-lost are gone.) A plain "is the
 * AI healthy?" verdict leads; four tabs answer one question each.
 */

type Likelihood = 'high' | 'medium' | 'low'

interface DriftMetric {
  label: string
  last7d: number
  prior23d: number
  deltaPct: number | null
  flagged: boolean
  format: 'count' | 'rate_per_day' | 'percent' | 'decimal'
}
interface CategoryMixRow { category: string; count30d: number; pct30d: number; pctShift7d: number }
interface LowConfidenceRow {
  id: string; classifiedAt: string | null; name: string | null; email: string | null
  tier: number | null; recoveryLikelihood: Likelihood | null; confidence: number | null
  cancellationReason: string | null; cancellationCategory: string | null
  productName: string | null; customerEmail: string | null
}
interface LikelihoodRow { likelihood: Likelihood; n: number; recovered: number; recoveryRatePct: number }
interface SuppressionReversal {
  suppressed: number; recovered: number
  reversedSample: Array<{ subscriberId: string; name: string | null; email: string | null; recoveredAt: string | null }>
}
interface RankedRow {
  subscriberId: string; name: string | null; email: string | null
  productName: string | null; mrrCents: number; tenureDays: number | null
  cancellationReason: string | null; cancellationCategory: string | null
  recoveryLikelihood: Likelihood | null; replyCount: number; billingPortalClicked: boolean
  interestScore: number
}
interface EmailPerfRow { type: string; sent: number; replied: number; replyRatePct: number }
interface FlaggedEmail { emailId: string; subject: string | null; type: string | null; note: string | null; subscriberId: string | null; flaggedAt: string }

interface Payload {
  verdict: { status: 'healthy' | 'attention'; reasons: string[] }
  drift: { metrics: DriftMetric[] }
  categoryMix: { rows: CategoryMixRow[]; total30d: number }
  lowConfidence: LowConfidenceRow[]
  calibration: { startDate: string; endDate: string; total: number; byLikelihood: LikelihoodRow[]; suppressionReversal: SuppressionReversal }
  matchRate: { windowDays: number; eligible: number; emailed: number; expired: number; pending: number }
  suppressionAudit: RankedRow[]
  emails: { windowDays: number; byType: EmailPerfRow[]; flaggedCount: number; recentFlagged: FlaggedEmail[] }
}

type Tab = 'health' | 'trust' | 'emails' | 'reasons'

const TAB_META: Array<{ key: Tab; label: string; sub: string }> = [
  { key: 'health',  label: 'Health',  sub: 'Did something change?' },
  { key: 'trust',   label: 'Trust',   sub: 'Can I believe its calls?' },
  { key: 'emails',  label: 'Emails',  sub: 'Are the emails landing?' },
  { key: 'reasons', label: 'Reasons', sub: 'Why people leave + hard cases' },
]

export function AiQualityClient() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('health')

  useEffect(() => {
    fetch('/api/admin/ai-quality', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (j.error) setError(j.error); else setData(j) })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) return <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm"><strong>Failed to load.</strong> {error}</div>
  if (!data) return <p className="text-sm text-slate-500">Loading…</p>

  const healthy = data.verdict.status === 'healthy'

  return (
    <div className="space-y-5">
      <header>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">Quality</div>
        <h1 className="text-3xl font-bold text-slate-900">AI quality.</h1>
        <p className="text-sm text-slate-500 max-w-3xl">
          The classifier reads each cancellation, writes the exit/win-back email, and labels it for re-engagement.
          This page asks: are those calls good, and would we notice if a prompt change broke them?
        </p>
      </header>

      {/* Verdict */}
      <div className={`rounded-2xl border p-4 ${healthy ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
        <div className="flex items-center gap-2">
          <span className="text-lg">{healthy ? '✓' : '⚠'}</span>
          <span className={`font-semibold ${healthy ? 'text-emerald-800' : 'text-amber-900'}`}>
            {healthy ? 'AI looks healthy' : 'AI needs attention'}
          </span>
        </div>
        {!healthy && (
          <ul className="mt-1.5 ml-7 list-disc text-sm text-amber-900 space-y-0.5">
            {data.verdict.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        )}
        {healthy && (
          <div className="ml-7 text-xs text-emerald-700/80 mt-0.5">No drift flags · confidence is calibrated · suppression reversal low.</div>
        )}
      </div>

      {/* Tabs */}
      <div className="bg-white border border-slate-200 rounded-2xl p-0.5 inline-flex text-sm flex-wrap">
        {TAB_META.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 rounded-xl font-medium text-left ${tab === t.key ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            {t.label}
            <span className={`block text-[10px] font-normal ${tab === t.key ? 'text-white/60' : 'text-slate-400'}`}>{t.sub}</span>
          </button>
        ))}
      </div>

      {tab === 'health'  && <HealthTab drift={data.drift} />}
      {tab === 'trust'   && <TrustTab calibration={data.calibration} audit={data.suppressionAudit} />}
      {tab === 'emails'  && <EmailsTab emails={data.emails} />}
      {tab === 'reasons' && <ReasonsTab mix={data.categoryMix} lowConf={data.lowConfidence} matchRate={data.matchRate} />}
    </div>
  )
}

// ─── Section + helpers ───

function Section({ title, why, children }: { title: string; why: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-sm font-semibold text-slate-900">{title}</div>
      <div className="text-[11px] text-slate-500 mb-3">{why}</div>
      {children}
    </section>
  )
}

function fmtMetric(v: number, format: DriftMetric['format']): string {
  if (format === 'percent') return `${v.toFixed(1)}%`
  if (format === 'decimal') return v.toFixed(2)
  if (format === 'rate_per_day') return `${v.toFixed(1)}/day`
  return Math.round(v).toString()
}

function relDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString()
}

// ─── Health ───

function HealthTab({ drift }: { drift: Payload['drift'] }) {
  return (
    <Section title="Drift — week vs. baseline" why="Catches a prompt regression the day it happens: last 7 days vs. the prior 23. A flagged row moved ≥20% in the bad direction.">
      <table className="w-full text-sm">
        <thead className="text-[10px] uppercase tracking-wide text-slate-400 text-left">
          <tr>
            <th className="py-1.5">Metric</th>
            <th className="py-1.5 text-right">Last 7d</th>
            <th className="py-1.5 text-right">Prior 23d</th>
            <th className="py-1.5 text-right">Δ</th>
            <th className="py-1.5 text-right">Flag</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {drift.metrics.map((m) => (
            <tr key={m.label} className={m.flagged ? 'bg-amber-50/50' : ''}>
              <td className="py-2 text-slate-700">{m.label}</td>
              <td className="py-2 text-right tabular-nums font-medium">{fmtMetric(m.last7d, m.format)}</td>
              <td className="py-2 text-right tabular-nums text-slate-500">{fmtMetric(m.prior23d, m.format)}</td>
              <td className={`py-2 text-right tabular-nums ${m.deltaPct === null ? 'text-slate-300' : m.flagged ? 'text-amber-700 font-semibold' : 'text-slate-500'}`}>
                {m.deltaPct === null ? '—' : `${m.deltaPct > 0 ? '+' : ''}${m.deltaPct}%`}
              </td>
              <td className="py-2 text-right">{m.flagged ? <span className="text-amber-600">⚠</span> : <span className="text-slate-300">✓</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

// ─── Trust ───

function TrustTab({ calibration, audit }: { calibration: Payload['calibration']; audit: RankedRow[] }) {
  const c = calibration
  const high = c.byLikelihood.find((r) => r.likelihood === 'high')
  const med  = c.byLikelihood.find((r) => r.likelihood === 'medium')
  const low  = c.byLikelihood.find((r) => r.likelihood === 'low')
  const monotonic = (high?.recoveryRatePct ?? 0) >= (med?.recoveryRatePct ?? 0) && (med?.recoveryRatePct ?? 0) >= (low?.recoveryRatePct ?? 0)
  const maxRate = Math.max(1, ...c.byLikelihood.map((r) => r.recoveryRatePct))
  const sup = c.suppressionReversal
  const supPct = sup.suppressed > 0 ? Math.round((sup.recovered / sup.suppressed) * 1000) / 10 : 0

  return (
    <div className="space-y-4">
      <Section
        title="Calibration — does confidence mean anything?"
        why={`Settled cohort (classified 30–90 days ago, n=${c.total}). If "high likelihood" subscribers don't recover more than "low", the AI's confidence is noise.`}
      >
        {c.byLikelihood.every((r) => r.n === 0) ? (
          <div className="text-sm text-slate-400">Not enough settled data yet.</div>
        ) : (
          <>
            <div className="space-y-2">
              {(['high', 'medium', 'low'] as const).map((lh) => {
                const r = c.byLikelihood.find((x) => x.likelihood === lh)
                const rate = r?.recoveryRatePct ?? 0
                return (
                  <div key={lh} className="flex items-center gap-3 text-sm">
                    <div className="w-20 text-slate-500 capitalize">{lh}</div>
                    <div className="flex-1 bg-slate-100 rounded-full h-5 overflow-hidden">
                      <div className="h-full bg-emerald-400 rounded-full flex items-center justify-end pr-2 min-w-[2rem]" style={{ width: `${(rate / maxRate) * 100}%` }}>
                        <span className="text-[10px] font-semibold text-white">{rate}%</span>
                      </div>
                    </div>
                    <div className="w-28 text-right text-[11px] text-slate-400 tabular-nums">{r?.recovered ?? 0}/{r?.n ?? 0} recovered</div>
                  </div>
                )
              })}
            </div>
            <div className={`mt-3 text-xs ${monotonic ? 'text-emerald-700' : 'text-amber-700'}`}>
              {monotonic ? '✓ Calibrated — recovery rate decreases from high → low as it should.' : '⚠ Not calibrated — high-likelihood subscribers aren\'t recovering more than low. The confidence signal is unreliable.'}
            </div>
          </>
        )}
      </Section>

      <Section
        title="Suppression reversal — did we silence the wrong people?"
        why="The AI's only 'don't bother' decision is tier 4 (no email). Of those it suppressed in the settled cohort, how many recovered anyway? A non-trivial rate = false negatives."
      >
        <div className="flex items-baseline gap-3">
          <div className={`text-2xl font-bold ${supPct > 10 ? 'text-amber-600' : 'text-slate-900'}`}>{supPct}%</div>
          <div className="text-sm text-slate-500">{sup.recovered} of {sup.suppressed} suppressed subscribers recovered on their own</div>
        </div>
        {sup.reversedSample.length > 0 && (
          <div className="mt-3 space-y-1 text-[12px]">
            <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">Recovered despite being suppressed — read these</div>
            {sup.reversedSample.map((r) => (
              <Link key={r.subscriberId} href={`/admin/subscribers/${r.subscriberId}`} className="flex items-center justify-between hover:bg-slate-50 rounded px-1 py-0.5">
                <span className="text-slate-700">{r.name ?? '(no name)'} <span className="text-slate-400 font-mono">· {r.email}</span></span>
                <span className="text-[10px] text-slate-400">recovered {relDate(r.recoveredAt)} →</span>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Suppression spot-check — highest-value cases the AI didn't email"
        why="Tier-4 (suppressed) subscribers ranked by value signals (MRR, replies, portal-clicks, addressable category). Skim the top — none should look obviously recoverable."
      >
        {audit.length === 0 ? (
          <div className="text-sm text-slate-400">No suppressed subscribers to review.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-slate-400 text-left">
              <tr><th className="py-1.5">Subscriber</th><th className="py-1.5">Category</th><th className="py-1.5 text-right">MRR</th><th className="py-1.5 text-right">Replies</th><th className="py-1.5 text-right">Score</th><th></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {audit.map((r) => (
                <tr key={r.subscriberId} className="hover:bg-slate-50">
                  <td className="py-2"><div className="text-slate-800">{r.name ?? '(no name)'}</div><div className="text-[10px] text-slate-400">{r.productName ?? '—'}</div></td>
                  <td className="py-2 text-[11px] text-slate-600">{r.cancellationCategory ?? '—'}</td>
                  <td className="py-2 text-right tabular-nums">${(r.mrrCents / 100).toFixed(0)}</td>
                  <td className="py-2 text-right tabular-nums">{r.replyCount}</td>
                  <td className="py-2 text-right tabular-nums font-medium">{r.interestScore}</td>
                  <td className="py-2 text-right"><Link href={`/admin/subscribers/${r.subscriberId}`} className="text-[10px] text-blue-600">open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  )
}

// ─── Emails ───

function EmailsTab({ emails }: { emails: Payload['emails'] }) {
  return (
    <div className="space-y-4">
      <Section
        title={`Reply rate by email type (last ${emails.windowDays}d)`}
        why="The AI writes every email's copy. People replying means it landed — the most direct quality signal for the copy. ($ recovered lives on Insights.)"
      >
        {emails.byType.length === 0 ? (
          <div className="text-sm text-slate-400">No emails sent in the window.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-slate-400 text-left">
              <tr><th className="py-1.5">Type</th><th className="py-1.5 text-right">Sent</th><th className="py-1.5 text-right">Replied</th><th className="py-1.5 text-right">Reply rate</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {emails.byType.map((r) => (
                <tr key={r.type}>
                  <td className="py-2 font-mono text-[12px] text-slate-700">{r.type}</td>
                  <td className="py-2 text-right tabular-nums">{r.sent}</td>
                  <td className="py-2 text-right tabular-nums">{r.replied}</td>
                  <td className="py-2 text-right tabular-nums font-semibold text-emerald-700">{r.replyRatePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section
        title={`Flagged for review (${emails.flaggedCount})`}
        why="Emails a human flagged from the subscriber inspector — the prompt's weak spots, queued for tuning."
      >
        {emails.recentFlagged.length === 0 ? (
          <div className="text-sm text-slate-400">No flagged emails. 🎉</div>
        ) : (
          <div className="space-y-1.5 text-[12px]">
            {emails.recentFlagged.map((f) => (
              <div key={f.emailId} className="flex items-start justify-between gap-3 hover:bg-slate-50 rounded px-1 py-1">
                <div className="min-w-0">
                  <div className="text-slate-800 truncate">
                    {f.type && <span className="font-mono text-[10px] bg-slate-100 rounded px-1 mr-1.5">{f.type}</span>}
                    {f.subject ?? '(no subject)'}
                  </div>
                  {f.note && <div className="text-[11px] text-amber-700 italic">&ldquo;{f.note}&rdquo;</div>}
                </div>
                {f.subscriberId && <Link href={`/admin/subscribers/${f.subscriberId}`} className="text-[10px] text-blue-600 shrink-0">open →</Link>}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

// ─── Reasons ───

function ReasonsTab({ mix, lowConf, matchRate }: { mix: Payload['categoryMix']; lowConf: LowConfidenceRow[]; matchRate: Payload['matchRate'] }) {
  const mr = matchRate
  return (
    <div className="space-y-4">
      <Section title={`Why people leave (last 30d · n=${mix.total30d})`} why="The cancellation-category mix + how it shifted this week. A sudden shift is a product signal; a flat single bucket can mean the classifier is collapsing categories.">
        {mix.rows.length === 0 ? (
          <div className="text-sm text-slate-400">No classified cancellations in the window.</div>
        ) : (
          <div className="space-y-2">
            {mix.rows.map((r) => (
              <div key={r.category} className="flex items-center gap-3 text-sm">
                <div className="w-24 text-slate-700">{r.category}</div>
                <div className="flex-1 bg-slate-100 rounded-full h-4 overflow-hidden">
                  <div className="h-full bg-blue-400 rounded-full" style={{ width: `${r.pct30d}%` }} />
                </div>
                <div className="w-16 text-right text-[11px] text-slate-500 tabular-nums">{r.pct30d.toFixed(0)}%</div>
                <div className={`w-14 text-right text-[11px] tabular-nums ${Math.abs(r.pctShift7d) >= 5 ? 'text-amber-700 font-medium' : 'text-slate-400'}`}>
                  {r.pctShift7d > 0 ? '+' : ''}{r.pctShift7d.toFixed(0)}pp
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Re-engagement match rate" why={`Of high-signal cancellations in the last ${mr.windowDays}d, how many got matched to a merchant improvement and emailed vs. expired without a match.`}>
        <div className="grid grid-cols-4 gap-2 text-center">
          {[
            { label: 'Eligible', v: mr.eligible, c: 'text-slate-900' },
            { label: 'Emailed',  v: mr.emailed,  c: 'text-emerald-600' },
            { label: 'Pending',  v: mr.pending,  c: 'text-slate-900' },
            { label: 'Expired',  v: mr.expired,  c: mr.expired > 0 ? 'text-amber-600' : 'text-slate-900' },
          ].map((x) => (
            <div key={x.label} className="rounded-lg border border-slate-100 p-2">
              <div className="text-[10px] uppercase tracking-widest text-slate-500">{x.label}</div>
              <div className={`text-xl font-bold ${x.c}`}>{x.v}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Where the AI hedged (low confidence < 0.4)" why="The cases the AI itself flagged as uncertain — reading them concentrates the prompt's weak spots.">
        {lowConf.length === 0 ? (
          <div className="text-sm text-slate-400">No low-confidence classifications. 🎉</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[10px] uppercase tracking-wide text-slate-400 text-left">
              <tr><th className="py-1.5">Subscriber</th><th className="py-1.5">Category</th><th className="py-1.5 text-right">Conf</th><th className="py-1.5">Reason</th><th></th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lowConf.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="py-2"><div className="text-slate-800">{r.name ?? '(no name)'}</div><div className="text-[10px] text-slate-400">{r.productName ?? '—'}</div></td>
                  <td className="py-2 text-[11px] text-slate-600">{r.cancellationCategory ?? '—'}</td>
                  <td className="py-2 text-right tabular-nums text-amber-700">{r.confidence !== null ? r.confidence.toFixed(2) : '—'}</td>
                  <td className="py-2 text-[11px] text-slate-500 truncate max-w-xs">{r.cancellationReason ?? '—'}</td>
                  <td className="py-2 text-right"><Link href={`/admin/subscribers/${r.id}`} className="text-[10px] text-blue-600">open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  )
}

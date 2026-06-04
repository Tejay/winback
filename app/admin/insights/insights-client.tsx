'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  KpiTile,
  MetricTile,
  TierBreakdown,
  FunnelStages,
  formatCents,
} from '@/components/admin/metric-tiles'
import { RefreshAffordance } from '@/components/admin-refresh'

/**
 * /admin/insights — the business dashboard, redesigned around what
 * WinbackFlow is. Three questions: are we making money (§1), growing
 * (§2), delivering value (§3). Every KPI drills to a real list.
 */

type InsightsWindow = '7d' | '30d' | '90d'

interface InsightsData {
  window: InsightsWindow
  stripeMode: 'test' | 'live'
  platform: {
    mrrCents: number
    payingMerchants: number
    enterpriseMerchants: number
    tierCounts: { starter: number; growth: number; scale: number; enterprise: number; custom: number }
    arpaCents: number
    subsAddedInWindow: number
    subsCanceledInWindow: number
    reactivationsInWindow: number
  }
  funnel: {
    totalMerchants: number
    activated: number
    paying: number
    stuckAtPaywall: number
    signupsInWindow: number
    conversionsInWindow: number
    activePilots: number
    pilotsEverIssued: number
    pilotsConverted: number
  }
  value: {
    recoveredCentsInWindow: number
    recoveredAllTimeCents: number
    recoveriesByAttribution: {
      strong:  { n: number; cents: number }
      weak:    { n: number; cents: number }
      organic: { n: number; cents: number }
    }
    recoveryRatePct: number | null
    recoveredCount: number
    lostCount: number
    byMode: { winBack: { n: number; cents: number }; cardSave: { n: number; cents: number } }
    engine: { ingested: number; contacted: number; recovered: number }
  }
  mrrTrend: Array<{ week: string; winBackCents: number; paymentCents: number }>
}

const WINDOW_OPTIONS: InsightsWindow[] = ['7d', '30d', '90d']
const WINDOW_LABEL: Record<InsightsWindow, string> = { '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' }

export function InsightsClient() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <InsightsInner />
    </Suspense>
  )
}

function InsightsInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const urlWindow = searchParams.get('window')
  const initialWindow: InsightsWindow = (WINDOW_OPTIONS as string[]).includes(urlWindow ?? '')
    ? (urlWindow as InsightsWindow)
    : '30d'

  const [window, setWindow] = useState<InsightsWindow>(initialWindow)
  const [data, setData] = useState<InsightsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)

  const load = useCallback(async (w: InsightsWindow) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/insights?window=${w}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load insights')
      setData(json)
      setLastLoadedAt(Date.now())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const qs = window !== '30d' ? `?window=${window}` : ''
    router.replace(`${pathname}${qs}`)
    load(window)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window])

  if (loading && !data) return <p className="text-sm text-slate-500">Loading…</p>
  if (error && !data) {
    return <div className="bg-red-50 border border-red-200 text-red-800 rounded-xl p-4 text-sm"><strong>Failed to load.</strong> {error}</div>
  }
  if (!data) return null

  const p = data.platform
  const f = data.funnel
  const v = data.value
  const winLabel = WINDOW_LABEL[window].toLowerCase()

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">Growth &amp; revenue</div>
          <h1 className="text-3xl font-bold text-slate-900">Insights.</h1>
          <p className="text-sm text-slate-500">
            Are we making money, growing, and delivering value. Stripe mode: <span className="font-mono">{data.stripeMode}</span>.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="bg-white border border-slate-200 rounded-full p-0.5 inline-flex text-xs">
            {WINDOW_OPTIONS.map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={`px-3 py-1 rounded-full font-medium ${window === w ? 'bg-slate-900 text-white' : 'text-slate-600'}`}
              >
                {w}
              </button>
            ))}
          </div>
          <RefreshAffordance lastLoadedAt={lastLoadedAt} onRefresh={() => load(window)} loading={loading} />
        </div>
      </header>

      {/* ===== §1 Platform revenue ===== */}
      <section className="space-y-3">
        <SectionHeader n="1" title="Platform revenue" sub="WinbackFlow's own subscription business" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <KpiTile
            label="Platform MRR"
            value={formatCents(p.mrrCents)}
            caption={`${p.payingMerchants} paying${p.enterpriseMerchants > 0 ? ` · +${p.enterpriseMerchants} enterprise (sales-priced)` : ''}`}
            href="/admin/customers?filter=paying"
            tone="pop"
          />
          <TierBreakdown dist={p.tierCounts} hrefFor={(tier) => `/admin/customers?filter=tier_${tier}`} />
          <div className="grid grid-cols-2 gap-3 content-start">
            <MetricTile label="ARPA" value={formatCents(p.arpaCents)} caption="avg revenue / account" href="/admin/customers?filter=paying" />
            <MetricTile label={`Subs added (${window})`} value={p.subsAddedInWindow} caption="new subscriptions" href="/admin/events?name=platform_subscription_created" valueColor={p.subsAddedInWindow > 0 ? 'text-emerald-600' : 'text-slate-900'} />
            <MetricTile label={`Subs canceled (${window})`} value={p.subsCanceledInWindow} caption="merchant churn" href="/admin/events?name=platform_subscription_canceled" valueColor={p.subsCanceledInWindow > 0 ? 'text-red-600' : 'text-slate-900'} />
            <MetricTile label={`Reactivations (${window})`} value={p.reactivationsInWindow} caption="win-back of merchants" href="/admin/events?name=platform_subscription_reactivated" valueColor={p.reactivationsInWindow > 0 ? 'text-emerald-600' : 'text-slate-900'} />
          </div>
        </div>
      </section>

      {/* ===== §2 Acquisition funnel ===== */}
      <section className="space-y-3">
        <SectionHeader n="2" title="Acquisition funnel" sub="Signup → activated → paying, plus pilots" />
        <FunnelStages
          stages={[
            { label: 'Merchants',  value: f.totalMerchants, href: '/admin/customers' },
            { label: 'Activated',  value: f.activated,      href: '/admin/customers?filter=activated' },
            { label: 'Paying',     value: f.paying,         href: '/admin/customers?filter=paying' },
          ]}
        />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricTile label={`Signups (${window})`} value={f.signupsInWindow} caption="new merchants" href="/admin/customers" />
          <MetricTile label={`Trial → paid (${window})`} value={f.conversionsInWindow} caption="subscriptions created" href="/admin/events?name=platform_subscription_created" valueColor={f.conversionsInWindow > 0 ? 'text-emerald-600' : 'text-slate-900'} />
          <MetricTile label="Stuck at paywall" value={f.stuckAtPaywall} caption="activated, no card — the leak" href="/admin/customers?filter=paywall_stuck" valueColor={f.stuckAtPaywall > 0 ? 'text-amber-600' : 'text-slate-900'} />
          <MetricTile
            label="Active pilots"
            value={f.activePilots}
            caption={`${f.pilotsConverted}/${f.pilotsEverIssued} pilots → paid`}
            href="/admin/pilots"
          />
        </div>
      </section>

      {/* ===== §3 Value delivered ===== */}
      <section className="space-y-3">
        <SectionHeader
          n="3"
          title="Value delivered"
          sub={`${formatCents(v.recoveredCentsInWindow)} recovered in the ${winLabel} — the reason merchants stay`}
        />

        {/* The two product lines, in plain language, lead the section. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <ProductLineTile
            label="Cancellation win-backs"
            caption="voluntary cancels reactivated"
            line={v.byMode.winBack}
            accent="emerald"
            href="/admin/subscribers?cohort=recovered"
          />
          <ProductLineTile
            label="Payment recoveries"
            caption="failed payments saved"
            line={v.byMode.cardSave}
            accent="blue"
            href="/admin/subscribers?cohort=recovered"
          />
        </div>

        {/* Stacked weekly trend by the same two product lines. */}
        <MrrTrendChart trend={data.mrrTrend} />

        {/* Supporting: lifetime totals, recovery rate, attribution, engine. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <MetricTile
            label="$ recovered all-time"
            value={formatCents(v.recoveredAllTimeCents)}
            caption="cumulative revenue saved for merchants"
            href="/admin/subscribers?cohort=recovered"
            valueColor="text-emerald-600"
          />
          <MetricTile
            label="Recovery rate (lifetime)"
            value={v.recoveryRatePct !== null ? `${v.recoveryRatePct}%` : '—'}
            caption={`${v.recoveredCount.toLocaleString()} recovered · ${v.lostCount.toLocaleString()} lost`}
            href="/admin/subscribers?cohort=recovered"
          />
          <div
            className="bg-white rounded-xl border border-slate-100 p-3"
            title="How confident we are that WinbackFlow caused the recovery. Strong = clear causation (clicked our email/link); Weak = plausible; Organic = returned on their own."
          >
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">Attributable to us ({window})</div>
            <div className="grid grid-cols-3 gap-1.5 text-center">
              <AttributionCell label="Strong" cell={v.recoveriesByAttribution.strong} tone="text-emerald-700" />
              <AttributionCell label="Weak" cell={v.recoveriesByAttribution.weak} tone="text-slate-700" />
              <AttributionCell label="Organic" cell={v.recoveriesByAttribution.organic} tone="text-slate-500" />
            </div>
          </div>
        </div>

        {/* Recovery engine funnel */}
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">Recovery engine ({window})</div>
          <FunnelStages
            stages={[
              { label: 'Ingested',  value: v.engine.ingested,  href: '/admin/subscribers' },
              { label: 'Contacted', value: v.engine.contacted },
              { label: 'Recovered', value: v.engine.recovered, href: '/admin/subscribers?cohort=recovered' },
            ]}
          />
        </div>
      </section>
    </div>
  )
}

function SectionHeader({ n, title, sub }: { n: string; title: string; sub: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-900 text-white text-[11px] font-bold">{n}</span>
      <div>
        <h2 className="text-lg font-semibold text-slate-900 leading-tight">{title}</h2>
        <div className="text-[11px] text-slate-500">{sub}</div>
      </div>
    </div>
  )
}

/**
 * One of the two product lines — the hero framing of §3. Big $, recovery
 * count, a sub-line, and a left accent bar in the line's color (matching
 * the trend chart legend).
 */
function ProductLineTile({
  label, caption, line, accent, href,
}: {
  label: string
  caption: string
  line: { n: number; cents: number }
  accent: 'emerald' | 'blue'
  href: string
}) {
  const bar = accent === 'emerald' ? 'bg-emerald-400' : 'bg-blue-400'
  const val = accent === 'emerald' ? 'text-emerald-600' : 'text-blue-600'
  return (
    <Link href={href} className="block bg-white rounded-2xl border border-slate-200 p-5 hover:border-slate-300 hover:shadow-sm transition">
      <div className="flex items-stretch gap-3">
        <div className={`w-1 rounded-full ${bar}`} />
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-600">{label}</div>
            <span className="text-[10px] text-blue-600">view →</span>
          </div>
          <div className={`text-3xl font-bold mt-1 ${val}`}>{formatCents(line.cents)}</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            <span className="font-medium text-slate-700">{line.n.toLocaleString()}</span> recoveries · {caption}
          </div>
        </div>
      </div>
    </Link>
  )
}

function AttributionCell({ label, cell, tone }: { label: string; cell: { n: number; cents: number }; tone: string }) {
  return (
    <div className="rounded-lg border border-slate-100 p-1.5">
      <div className="text-[9px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`text-sm font-bold ${tone}`}>{formatCents(cell.cents)}</div>
      <div className="text-[9px] text-slate-400">{cell.n.toLocaleString()} rec.</div>
    </div>
  )
}

/**
 * Recovered-MRR weekly trend — stacked by product line (cancellation
 * win-backs + payment recoveries), 13 weeks. Period total + weekly avg
 * headline, legend, month x-axis, hover tooltip. Designed to read as a
 * trend at a glance, not require hovering each bar.
 */
function MrrTrendChart({ trend }: { trend: InsightsData['mrrTrend'] }) {
  const weeks = trend.map((w) => ({ ...w, total: w.winBackCents + w.paymentCents }))
  const max = Math.max(1, ...weeks.map((w) => w.total))
  const periodTotal = weeks.reduce((s, w) => s + w.total, 0)
  const weeklyAvg = weeks.length > 0 ? Math.round(periodTotal / weeks.length) : 0
  const hasData = periodTotal > 0

  // Month label under the first week of each calendar month.
  function monthLabel(week: string, idx: number): string {
    const m = new Date(week + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
    if (idx === 0) return m
    const prev = new Date(weeks[idx - 1].week + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
    return m !== prev ? m : ''
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">Recovered MRR · weekly, last 13 weeks</div>
          <div className="text-sm text-slate-700 mt-0.5">
            <span className="font-bold">{formatCents(periodTotal)}</span> recovered
            <span className="text-slate-400"> · avg {formatCents(weeklyAvg)}/wk</span>
          </div>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-500">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-400 inline-block" />Cancellation win-backs</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-blue-400 inline-block" />Payment recoveries</span>
        </div>
      </div>

      {!hasData ? (
        <div className="text-[12px] text-slate-400 py-8 text-center">No recoveries in the last 13 weeks.</div>
      ) : (
        <div className="relative">
          {/* y-axis max gridline */}
          <div className="absolute inset-x-0 top-0 border-t border-dashed border-slate-200">
            <span className="text-[9px] text-slate-400 tabular-nums absolute right-0 -top-3.5">{formatCents(max)}</span>
          </div>
          <div className="flex items-end gap-1.5 h-40">
            {weeks.map((w) => (
              <div key={w.week} className="flex-1 flex justify-center group min-w-0 h-full items-end">
                <div
                  className="w-full max-w-[42px] flex flex-col-reverse rounded-t overflow-hidden h-full"
                  title={`Week of ${w.week}\nCancellation win-backs: ${formatCents(w.winBackCents)}\nPayment recoveries: ${formatCents(w.paymentCents)}\nTotal: ${formatCents(w.total)}`}
                >
                  {/* Stacked from the bottom; empty space above is the headroom to max. */}
                  <div style={{ height: `${(w.paymentCents / max) * 100}%` }} className="w-full bg-blue-400 group-hover:bg-blue-500 transition" />
                  <div style={{ height: `${(w.winBackCents / max) * 100}%` }} className="w-full bg-emerald-400 group-hover:bg-emerald-500 transition" />
                </div>
              </div>
            ))}
          </div>
          {/* month x-axis */}
          <div className="flex gap-1.5 mt-1">
            {weeks.map((w, i) => (
              <div key={w.week} className="flex-1 text-[9px] text-slate-400 text-center min-w-0">{monthLabel(w.week, i)}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

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
  mrrTrend: Array<{ week: string; attributionType: string; cents: number; n: number }>
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
        <SectionHeader n="3" title="Value delivered" sub="Proves the product works — the reason merchants stay" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <KpiTile
            label={`$ recovered (${window})`}
            value={formatCents(v.recoveredCentsInWindow)}
            caption={`${formatCents(v.recoveredAllTimeCents)} all-time`}
            href="/admin/subscribers?cohort=recovered"
            tone="pop"
          />
          <KpiTile
            label="Recovery rate"
            value={v.recoveryRatePct !== null ? `${v.recoveryRatePct}%` : '—'}
            caption={`${v.recoveredCount.toLocaleString()} recovered / ${v.lostCount.toLocaleString()} lost (lifetime)`}
            href="/admin/subscribers?cohort=recovered"
          />
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">By product mode ({window})</div>
            <ModeRow label="Win-back" caption="voluntary cancel → reactivation" mode={v.byMode.winBack} />
            <div className="h-px bg-slate-100 my-2" />
            <ModeRow label="Card-save" caption="failed payment recovered" mode={v.byMode.cardSave} />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Attribution split */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">Recoveries by attribution ({window})</div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <AttributionCell label="Strong" cell={v.recoveriesByAttribution.strong} tone="text-emerald-700" />
              <AttributionCell label="Weak" cell={v.recoveriesByAttribution.weak} tone="text-slate-700" />
              <AttributionCell label="Organic" cell={v.recoveriesByAttribution.organic} tone="text-slate-500" />
            </div>
          </div>

          {/* Engine funnel */}
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
        </div>

        {/* MRR-recovered weekly trend (rescued from /admin/billing) */}
        <MrrTrendChart trend={data.mrrTrend} />
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

function ModeRow({ label, caption, mode }: { label: string; caption: string; mode: { n: number; cents: number } }) {
  return (
    <div className="flex items-baseline justify-between">
      <div>
        <div className="text-sm font-semibold text-slate-800">{label}</div>
        <div className="text-[10px] text-slate-400">{caption}</div>
      </div>
      <div className="text-right">
        <div className="text-lg font-bold text-slate-900">{formatCents(mode.cents)}</div>
        <div className="text-[10px] text-slate-400">{mode.n.toLocaleString()} recoveries</div>
      </div>
    </div>
  )
}

function AttributionCell({ label, cell, tone }: { label: string; cell: { n: number; cents: number }; tone: string }) {
  return (
    <div className="rounded-lg border border-slate-100 p-2">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`text-lg font-bold ${tone}`}>{formatCents(cell.cents)}</div>
      <div className="text-[10px] text-slate-400">{cell.n.toLocaleString()} rec.</div>
    </div>
  )
}

/** Simple CSS bar chart — total recovered MRR per week, last 13 weeks. */
function MrrTrendChart({ trend }: { trend: InsightsData['mrrTrend'] }) {
  // Sum attribution types per week.
  const byWeek = new Map<string, number>()
  for (const r of trend) byWeek.set(r.week, (byWeek.get(r.week) ?? 0) + r.cents)
  const weeks = Array.from(byWeek.entries()).sort(([a], [b]) => a.localeCompare(b))
  const max = Math.max(1, ...weeks.map(([, c]) => c))

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-3">MRR recovered · 13-week trend</div>
      {weeks.length === 0 ? (
        <div className="text-[12px] text-slate-400">No recoveries recorded yet.</div>
      ) : (
        <div className="flex items-end gap-1.5 h-32">
          {weeks.map(([week, cents]) => (
            <div key={week} className="flex-1 flex flex-col items-center gap-1 group">
              <div className="text-[9px] text-slate-400 opacity-0 group-hover:opacity-100 transition tabular-nums whitespace-nowrap">
                {formatCents(cents)}
              </div>
              <div
                className="w-full bg-blue-400 rounded-t hover:bg-blue-500 transition"
                style={{ height: `${Math.max(2, (cents / max) * 100)}%` }}
                title={`${week}: ${formatCents(cents)}`}
              />
              <div className="text-[8px] text-slate-400 tabular-nums">{week.slice(5)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

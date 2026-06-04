'use client'

import Link from 'next/link'

/**
 * Shared admin metric tiles. Used by the Now page (Sparkline only) and the
 * Insights page (the rest). Every tile takes an optional `href` so a KPI
 * drills straight to the list behind it.
 */

export function formatCents(cents: number, opts: { decimals?: boolean } = {}): string {
  const dollars = cents / 100
  return `$${dollars.toLocaleString(undefined, {
    minimumFractionDigits: opts.decimals ? 2 : 0,
    maximumFractionDigits: opts.decimals ? 2 : 0,
  })}`
}

function maybeLink(href: string | undefined, className: string, children: React.ReactNode) {
  if (!href) return <div className={className}>{children}</div>
  return <Link href={href} className={`${className} hover:border-slate-300 hover:shadow-sm transition`}>{children}</Link>
}

/**
 * Headline KPI — big value, label, caption, optional drill. Use for the
 * one or two numbers that lead a section (Platform MRR, $ recovered).
 */
export function KpiTile({
  label, value, caption, href, tone = 'default',
}: {
  label: string
  value: string
  caption?: string
  href?: string
  tone?: 'default' | 'pop' | 'warn'
}) {
  const valueColor = tone === 'pop' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-slate-900'
  return maybeLink(
    href,
    'block bg-white rounded-2xl border border-slate-200 p-5',
    <>
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</div>
        {href && <span className="text-[10px] text-blue-600">view →</span>}
      </div>
      <div className={`text-3xl font-bold mt-1 ${valueColor}`}>{value}</div>
      {caption && <div className="text-[11px] text-slate-400 mt-0.5">{caption}</div>}
    </>,
  )
}

/**
 * Small single-value tile with a plain caption. For supporting metrics.
 */
export function MetricTile({
  label, value, caption, href, valueColor = 'text-slate-900',
}: {
  label: string
  value: string | number
  caption?: string
  href?: string
  valueColor?: string
}) {
  return maybeLink(
    href,
    'block bg-white rounded-xl border border-slate-100 p-3',
    <>
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">{label}</div>
        {href && <span className="text-[10px] text-blue-600">→</span>}
      </div>
      <div className={`text-xl font-bold ${valueColor}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {caption && <div className="text-[10px] text-slate-400 mt-0.5">{caption}</div>}
    </>,
  )
}

/**
 * Tier breakdown with a per-row drill link. Headline = total paying subs.
 */
export function TierBreakdown({
  dist,
  hrefFor,
}: {
  dist: { starter: number; growth: number; scale: number; enterprise: number; custom: number }
  hrefFor?: (tier: string) => string
}) {
  const total = dist.starter + dist.growth + dist.scale + dist.enterprise + dist.custom
  const rows: Array<[string, string, number]> = [
    ['Starter',    'starter',    dist.starter],
    ['Growth',     'growth',     dist.growth],
    ['Scale',      'scale',      dist.scale],
    ['Enterprise', 'enterprise', dist.enterprise],
    ['Custom',     'custom',     dist.custom],
  ]
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">Paying merchants by tier</div>
      <div className="flex items-baseline gap-2 mb-2">
        <div className="text-2xl font-bold">{total.toLocaleString()}</div>
        <div className="text-[10px] text-slate-400">paying</div>
      </div>
      <div className="space-y-0.5">
        {rows.map(([label, key, n]) => {
          const href = hrefFor && n > 0 ? hrefFor(key) : undefined
          const inner = (
            <>
              <span className="text-slate-500">{label}</span>
              <span className="tabular-nums text-slate-700 font-medium">{n.toLocaleString()}</span>
            </>
          )
          return href ? (
            <Link key={key} href={href} className="flex items-center justify-between text-[11px] hover:bg-slate-50 rounded px-1 -mx-1">
              {inner}
            </Link>
          ) : (
            <div key={key} className="flex items-center justify-between text-[11px] px-1 -mx-1">{inner}</div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Horizontal funnel — stages with absolute counts and step-over-step
 * conversion %. Each stage drills to the rows at that stage.
 */
export function FunnelStages({
  stages,
}: {
  stages: Array<{ label: string; value: number; href?: string }>
}) {
  const first = stages[0]?.value ?? 0
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
        {stages.map((s, i) => {
          const prev = i > 0 ? stages[i - 1].value : null
          const stepPct = prev && prev > 0 ? Math.round((s.value / prev) * 100) : null
          const ofFirst = first > 0 ? Math.round((s.value / first) * 100) : null
          const inner = (
            <>
              <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{s.label}</div>
              <div className="text-2xl font-bold text-slate-900">{s.value.toLocaleString()}</div>
              <div className="text-[10px] text-slate-400">
                {ofFirst !== null && `${ofFirst}% of top`}
              </div>
            </>
          )
          return (
            <div key={s.label} className="relative">
              {i > 0 && (
                <div className="absolute -left-1 top-1/2 -translate-y-1/2 text-[10px] text-slate-400 z-10">
                  {stepPct !== null ? `${stepPct}%→` : ''}
                </div>
              )}
              {s.href
                ? <Link href={s.href} className="block rounded-xl border border-slate-100 p-3 hover:border-slate-300 hover:shadow-sm transition">{inner}</Link>
                : <div className="rounded-xl border border-slate-100 p-3">{inner}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Sparkline — used by the Now errors panel. Kept here so it lives once. */
export function Sparkline({ values, max }: { values: number[]; max: number }) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  return (
    <div className="font-mono text-blue-500 mt-2 leading-none text-[14px]">
      {values
        .map((v) => blocks[Math.min(blocks.length - 1, Math.floor((v / max) * (blocks.length - 1)))])
        .join('')}
    </div>
  )
}

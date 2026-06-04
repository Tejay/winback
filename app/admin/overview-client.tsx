'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ClassifierDeadLetterDrawer } from './classifier-dead-letter-drawer'

/**
 * PR 2 — /admin (Now).
 *
 * Ops-first layout: red lights → stuck cohorts → errors-with-tail →
 * cron health → recent admin activity → business metrics (collapsed).
 * Polled every 30s. See mockups/admin-overview-compare.html.
 */

type ErrorSource =
  | 'oauth_error'
  | 'billing_invoice_failed'
  | 'reactivate_failed'
  | 'email_send_failed'
  | 'classifier_failed'
  | 'webhook_signature_invalid'

type CronStatus = 'ok' | 'failed' | 'stale' | 'slow' | 'never-run'

interface OverviewRollup {
  today: {
    classifications: number
    emailsSent: number
    handoffs: number
    recoveries: { strong: number; weak: number; organic: number; total: number }
    mrrCents: number
    errors: { total: number; bySource: Record<ErrorSource, number> }
  }
  sparklines: {
    emailsSent: number[]
    handoffs: number[]
    recoveries: number[]
    mrrCents: number[]
    errors: number[]
  }
  growth: {
    signupsToday: number
    signups7d: number
    conversionsToday: number
    conversions7d: number
    customersActive24h: number
    customersActive7d: number
  }
  paywall: {
    stuckAtPaywall: number
    gateSkipsToday: number
    unpauseBlockedToday: number
  }
  billing: {
    tierDistribution: { starter: number; growth: number; scale: number; enterprise: number; custom: number }
    requiresSales: number
    subsCanceled7d: number
    reactivations7d: number
    invoiceFailedToday: number
  }
  redLights: Array<{
    metric: string
    kind: 'spike' | 'floor'
    today: number
    median7d: number
    summary: string
    concentration?: { customerId: string; customerEmail: string | null; n: number }
  }>
  errorsTail: Array<{
    id: string
    name: string
    customerId: string | null
    customerEmail: string | null
    snippet: string
    createdAt: string
  }>
  recentAdminActivity: Array<{
    id: string
    action: string
    adminEmail: string | null
    customerId: string | null
    customerEmail: string | null
    createdAt: string
  }>
  stuckCohorts: {
    oauthIssues: number
    classifierDeadLetter: number
    paywallStuck: number
    drainPausedQueue: number
    unclassifiedQueue: number
    backfillInFlight: number
  }
  cronHealth: Array<{
    name: string
    displayName: string
    label: string
    purpose: string
    staleImpact: string
    status: CronStatus
    lastRunAt: string | null
    durationMs: number | null
    avgDurationMs: number | null
    errorMessage: string | null
  }>
  /** Back-compat: same value as stuckCohorts.classifierDeadLetter */
  deadLetteredClassify: number
}

const ERROR_SOURCE_LABELS: Record<ErrorSource, string> = {
  oauth_error:                'OAuth',
  billing_invoice_failed:     'Billing',
  reactivate_failed:          'Reactivate',
  email_send_failed:          'Send',
  classifier_failed:          'AI',
  webhook_signature_invalid:  'Webhook',
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export function OverviewClient() {
  const [data, setData]     = useState<OverviewRollup | null>(null)
  const [error, setError]   = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [deadLetterOpen, setDeadLetterOpen] = useState(false)

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
    return () => { cancelled = true; clearInterval(t) }
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
    <div className="space-y-6">
      <Header />
      <RedLights lights={data.redLights} errorsBySource={data.today.errors.bySource} />
      <StuckCohortsPanel
        cohorts={data.stuckCohorts}
        onOpenDeadLetter={() => setDeadLetterOpen(true)}
      />
      <ErrorsPanel today={data.today.errors} spark={data.sparklines.errors} tail={data.errorsTail} />
      <CronHealthSection rows={data.cronHealth ?? []} />
      <RecentAdminActivity rows={data.recentAdminActivity} />
      <BusinessDisclosure data={data} />

      <ClassifierDeadLetterDrawer open={deadLetterOpen} onClose={() => setDeadLetterOpen(false)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header() {
  return (
    <header className="flex items-end justify-between flex-wrap gap-3">
      <div>
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
          Service health
        </div>
        <h1 className="text-3xl font-bold text-slate-900">Now.</h1>
        <p className="text-sm text-slate-500">Counters refresh every 30 seconds.</p>
      </div>
      <div className="text-[11px] text-slate-500 text-right leading-tight">
        <div>Email on red light: <span className="font-mono text-slate-700">errors@winbackflow.co</span></div>
        <div className="text-slate-400">cooldown 15 min · cron <span className="font-mono">red-light-check</span></div>
      </div>
    </header>
  )
}

// ---------------------------------------------------------------------------
// Red lights — extended with floor lights + concentration
// ---------------------------------------------------------------------------

function dominantErrorSource(bySource: Record<ErrorSource, number>): ErrorSource | null {
  let top: ErrorSource | null = null
  let max = 0
  for (const src of Object.keys(ERROR_SOURCE_LABELS) as ErrorSource[]) {
    const n = bySource[src] ?? 0
    if (n > max) { max = n; top = src }
  }
  return top
}

function investigateHref(metric: string, errorsBySource: Record<ErrorSource, number>): string {
  if (metric === 'errors') {
    const top = dominantErrorSource(errorsBySource)
    return top ? `/admin/events?name=${top}` : '/admin/events'
  }
  if (metric === 'handoffs')          return '/admin/events?name=founder_handoff_triggered'
  if (metric === 'subs_canceled')     return '/admin/events?name=platform_subscription_canceled'
  if (metric === 'invoice_failed')    return '/admin/events?name=billing_invoice_failed'
  if (metric === 'floor_emails_sent') return '/admin/events?name=email_sent'
  if (metric === 'floor_customers_active') return '/admin/events'
  return '/admin/events'
}

function RedLights({
  lights,
  errorsBySource,
}: {
  lights: OverviewRollup['redLights']
  errorsBySource: Record<ErrorSource, number>
}) {
  if (lights.length === 0) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl px-4 py-2.5 text-sm flex items-center gap-2">
        <span>✓</span>
        <span>No red lights active. <span className="text-emerald-700/70">All tracked rules within normal bands.</span></span>
      </div>
    )
  }
  return (
    <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm space-y-1.5">
      <div className="font-semibold text-red-900 uppercase text-xs tracking-wider">
        Red lights · {lights.length} active
      </div>
      {lights.map((rl) => {
        const marker = rl.kind === 'floor' ? '↓' : '↑'
        return (
          <div key={rl.metric} className="text-red-800 flex items-start gap-2">
            <span className="font-bold">{marker}</span>
            <div className="flex-1">
              <div>
                <strong className="font-mono">{rl.metric}</strong> — {rl.summary}
              </div>
              {rl.concentration && (
                <div className="text-[11px] text-red-700/80 mt-0.5">
                  concentrated in{' '}
                  <Link
                    href={`/admin/customers/${rl.concentration.customerId}`}
                    className="underline font-medium"
                  >
                    {rl.concentration.customerEmail ?? rl.concentration.customerId.slice(0, 8)}
                  </Link>
                  {' '}({rl.concentration.n} of {rl.today})
                </div>
              )}
            </div>
            <Link href={investigateHref(rl.metric, errorsBySource)} className="text-xs underline shrink-0">
              investigate →
            </Link>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Stuck cohorts — 6 worklist tiles
// ---------------------------------------------------------------------------

function StuckCohortsPanel({
  cohorts,
  onOpenDeadLetter,
}: {
  cohorts: OverviewRollup['stuckCohorts']
  onOpenDeadLetter: () => void
}) {
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Stuck cohorts · point-in-time worklist
        </div>
        <div className="text-[10px] text-slate-400">click any tile</div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <CohortTile
          label="OAuth issues"
          value={cohorts.oauthIssues}
          sub="3+ errors in 24h"
          tone={cohorts.oauthIssues > 0 ? 'danger' : 'ok'}
          href="/admin/customers?filter=oauth_issues"
        />
        <CohortTile
          label="Stuck after 3 tries"
          value={cohorts.classifierDeadLetter}
          sub="AI gave up · view & reset"
          tone={cohorts.classifierDeadLetter > 0 ? 'danger' : 'ok'}
          onClick={cohorts.classifierDeadLetter > 0 ? onOpenDeadLetter : undefined}
          // When count is 0, keep history link as the fallback action
          href={cohorts.classifierDeadLetter > 0 ? undefined : '/admin/events?name=classify_dead_lettered'}
        />
        <CohortTile
          label="Paywall stuck"
          value={cohorts.paywallStuck}
          sub="activated, no card"
          tone={cohorts.paywallStuck > 0 ? 'warn' : 'ok'}
          href="/admin/customers?filter=paywall_stuck"
        />
        <CohortTile
          label="Activation backlog"
          value={cohorts.drainPausedQueue}
          sub="post-billing catch-up"
          tone="ok"
          href="/admin/subscribers?cohort=drain_paused"
        />
        <CohortTile
          label="Pending AI review"
          value={cohorts.unclassifiedQueue}
          sub="classifier · attempts < 3"
          tone="ok"
          href="/admin/subscribers?cohort=unclassified"
        />
        <CohortTile
          label="Backfill in flight"
          value={cohorts.backfillInFlight}
          sub="customers importing"
          tone="ok"
          href="/admin/customers?filter=backfill_in_flight"
        />
      </div>
    </section>
  )
}

function CohortTile({
  label,
  value,
  sub,
  tone,
  href,
  onClick,
}: {
  label: string
  value: number
  sub: string
  tone: 'ok' | 'warn' | 'danger'
  href?: string
  onClick?: () => void
}) {
  const cls = tone === 'danger'
    ? 'border-red-200 bg-red-50/60 hover:bg-red-50 text-red-700'
    : tone === 'warn'
      ? 'border-amber-200 bg-amber-50/60 hover:bg-amber-50 text-amber-700'
      : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
  const labelCls = tone === 'danger' ? 'text-red-700'
                 : tone === 'warn'   ? 'text-amber-700'
                 : 'text-slate-500'
  const valueCls = tone === 'danger' ? 'text-red-700'
                 : tone === 'warn'   ? 'text-amber-700'
                 : 'text-slate-900'
  const subCls   = tone === 'danger' ? 'text-red-600/80'
                 : tone === 'warn'   ? 'text-amber-700/80'
                 : 'text-slate-500'
  const body = (
    <>
      <div className={`text-[10px] uppercase tracking-widest ${labelCls}`}>{label}</div>
      <div className={`text-2xl font-bold ${valueCls}`}>{value.toLocaleString()}</div>
      <div className={`text-[10px] ${subCls}`}>{sub}</div>
    </>
  )
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`text-left rounded-lg border p-3 transition ${cls}`}>
        {body}
      </button>
    )
  }
  if (href) {
    return (
      <Link href={href} className={`block rounded-lg border p-3 transition ${cls}`}>
        {body}
      </Link>
    )
  }
  return <div className={`rounded-lg border p-3 ${cls}`}>{body}</div>
}

// ---------------------------------------------------------------------------
// Errors panel (full-width) — counter + per-source pills + recent tail
// ---------------------------------------------------------------------------

function ErrorsPanel({
  today,
  spark,
  tail,
}: {
  today: { total: number; bySource: Record<ErrorSource, number> }
  spark: number[]
  tail: OverviewRollup['errorsTail']
}) {
  const max = Math.max(1, ...spark)
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">Errors · today</div>
        <Link href="/admin/events" className="text-[11px] text-blue-600 hover:underline">all errors →</Link>
      </div>
      <div className="flex items-baseline gap-4">
        <div className={`text-3xl font-bold ${today.total > 0 ? 'text-red-600' : 'text-slate-900'}`}>
          {today.total.toLocaleString()}
        </div>
        <Sparkline values={spark} max={max} />
      </div>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 mt-3">
        {(Object.keys(ERROR_SOURCE_LABELS) as ErrorSource[]).map((src) => {
          const n = today.bySource[src] ?? 0
          return (
            <Link
              key={src}
              href={`/admin/events?name=${src}`}
              className={`flex items-center justify-between px-2 py-1 rounded text-[11px] ${
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

      {tail.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 mb-1.5">
            Latest failures
          </div>
          <div className="space-y-0.5 text-[12px]">
            {tail.map((e) => (
              <Link
                key={e.id}
                href={
                  e.customerId
                    ? `/admin/events?customer=${e.customerId}&name=${e.name}`
                    : `/admin/events?name=${e.name}`
                }
                className="grid grid-cols-[60px_120px_1fr_auto] gap-2 items-center hover:bg-slate-50 rounded px-1 py-0.5"
              >
                <span className="font-mono text-[11px] text-slate-400">{relTime(e.createdAt)}</span>
                <span className="bg-red-50 text-red-700 rounded px-1.5 text-[10px] text-center truncate">{e.name}</span>
                <span className="truncate text-slate-700">
                  {e.customerEmail && <span className="font-mono text-blue-600">{e.customerEmail}</span>}
                  {e.customerEmail && e.snippet && <span> · </span>}
                  {e.snippet && <span className="text-slate-600">{e.snippet}</span>}
                  {!e.customerEmail && !e.snippet && <span className="text-slate-400">(no details)</span>}
                </span>
                <span className="text-[10px] text-blue-600 hover:underline">open →</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Cron health (extended for slow status)
// ---------------------------------------------------------------------------

function CronHealthSection({ rows }: { rows: OverviewRollup['cronHealth'] }) {
  function badge(status: CronStatus): { cls: string; label: string } {
    switch (status) {
      case 'ok':        return { cls: 'bg-green-50 text-green-700 border-green-200', label: '✓ ok' }
      case 'failed':    return { cls: 'bg-red-50  text-red-700  border-red-200',     label: '⚠ FAILED' }
      case 'stale':     return { cls: 'bg-amber-50 text-amber-700 border-amber-200', label: 'ⓘ stale' }
      case 'slow':      return { cls: 'bg-amber-50 text-amber-700 border-amber-200', label: '⚡ slow' }
      default:          return { cls: 'bg-slate-100 text-slate-500 border-slate-200', label: 'never run' }
    }
  }
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
        Cron health
      </div>
      <div className="divide-y divide-slate-100">
        {rows.map((r) => {
          const b = badge(r.status)
          const isBad = r.status === 'failed' || r.status === 'stale' || r.status === 'slow'
          return (
            <details key={r.name} className="group py-2.5 first:pt-0 last:pb-0">
              <summary className="cursor-pointer list-none flex items-center gap-3 flex-wrap hover:bg-slate-50 -mx-2 px-2 py-1 rounded-lg">
                <span className="text-slate-400 text-xs group-open:rotate-90 transition-transform inline-block w-3">▸</span>
                <span className="text-sm text-slate-700 font-medium min-w-[14rem]">{r.displayName}</span>
                <span className="text-xs text-slate-500 min-w-[10rem]">{r.label}</span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border ${b.cls}`}>
                  {b.label}
                </span>
                <span className="text-xs text-slate-500 ml-auto">
                  {r.lastRunAt ? `last run ${relTime(r.lastRunAt)}` : ''}
                  {r.durationMs !== null && (
                    <span className="text-slate-400 tabular-nums"> · {r.durationMs}ms</span>
                  )}
                  {r.avgDurationMs !== null && r.avgDurationMs > 0 && (
                    <span className="text-slate-300 tabular-nums"> (avg {r.avgDurationMs}ms)</span>
                  )}
                </span>
              </summary>
              <div className="pl-8 pr-2 pt-2 pb-1 space-y-1.5">
                <div className="text-xs text-slate-600 max-w-3xl">{r.purpose}</div>
                <div className={`text-xs max-w-3xl ${isBad ? 'text-amber-700' : 'text-slate-500'}`}>
                  <span className="font-medium">If stale:</span> {r.staleImpact}
                </div>
                {r.status === 'failed' && r.errorMessage && (
                  <div className="text-xs text-red-700 max-w-3xl">
                    <span className="font-medium">Error:</span> {r.errorMessage}
                  </div>
                )}
                {r.status === 'slow' && r.avgDurationMs && (
                  <div className="text-xs text-amber-700 max-w-3xl">
                    <span className="font-medium">Slow:</span> this run took {r.durationMs}ms vs rolling avg of {r.avgDurationMs}ms (≥3×).
                  </div>
                )}
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Recent admin activity
// ---------------------------------------------------------------------------

function RecentAdminActivity({ rows }: { rows: OverviewRollup['recentAdminActivity'] }) {
  if (rows.length === 0) {
    return (
      <section className="bg-white rounded-2xl border border-slate-200 p-4 text-sm flex items-center justify-between">
        <span className="text-slate-500">No admin actions yet today.</span>
        <Link href="/admin/audit-log" className="text-xs text-blue-600 hover:underline">all activity →</Link>
      </section>
    )
  }
  return (
    <section className="bg-white rounded-2xl border border-slate-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Recent admin activity
        </div>
        <Link href="/admin/audit-log" className="text-[11px] text-blue-600 hover:underline">all activity →</Link>
      </div>
      <div className="space-y-0.5 text-[12px]">
        {rows.map((r) => (
          <div key={r.id} className="grid grid-cols-[60px_140px_1fr] gap-2 items-center hover:bg-slate-50 rounded px-1 py-0.5">
            <span className="font-mono text-[11px] text-slate-400">{relTime(r.createdAt)}</span>
            <span className="font-mono text-[11px] text-amber-700 truncate">{r.action || '(unknown)'}</span>
            <span className="text-slate-700 truncate">
              {r.adminEmail ?? '(unknown admin)'}
              {r.customerId && (
                <>
                  {' '}on{' '}
                  <Link href={`/admin/customers/${r.customerId}`} className="text-blue-600 hover:underline font-mono">
                    {r.customerEmail ?? r.customerId.slice(0, 8)}
                  </Link>
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Business disclosure (collapsed: today counters, growth, paywall, billing)
// ---------------------------------------------------------------------------

function BusinessDisclosure({ data }: { data: OverviewRollup }) {
  const t = data.today
  const recs = `${t.recoveries.strong}S / ${t.recoveries.weak}W / ${t.recoveries.organic}O`
  const mrrDollars = `$${(t.mrrCents / 100).toFixed(2)}`
  return (
    <details className="bg-white rounded-2xl border border-slate-200 overflow-hidden group">
      <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between hover:bg-slate-50">
        <div className="flex items-center gap-2">
          <span className="text-slate-400 text-xs group-open:rotate-90 transition-transform inline-block w-3">▸</span>
          <span className="text-xs font-semibold uppercase tracking-widest text-slate-500">Business metrics</span>
          <span className="text-[11px] text-slate-500">
            Today's counters · growth · paywall · revenue
          </span>
        </div>
        <span className="text-[10px] text-slate-400 group-open:hidden">expand</span>
      </summary>
      <div className="border-t border-slate-100 p-4 space-y-5">
        <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <Counter label="Classifications" value={t.classifications} spark={data.sparklines.emailsSent} />
          <Counter label="Emails sent"     value={t.emailsSent}      spark={data.sparklines.emailsSent} />
          <Counter label="Hand-offs"       value={t.handoffs}        spark={data.sparklines.handoffs} />
          <Counter label="Recoveries"      value={t.recoveries.total} sub={recs} spark={data.sparklines.recoveries} />
          <Counter
            label="$ recovered (strong)"
            customValue={mrrDollars}
            value={t.mrrCents}
            spark={data.sparklines.mrrCents}
            tone={t.mrrCents > 0 ? 'pop' : 'ok'}
          />
        </section>

        <section>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">
            Growth &amp; health
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <GrowthTile label="New signups" today={data.growth.signupsToday} sevenDay={data.growth.signups7d} />
            <GrowthTile
              label="Trial → paid"
              today={data.growth.conversionsToday}
              sevenDay={data.growth.conversions7d}
              valueColor={data.growth.conversionsToday > 0 ? 'text-green-600' : 'text-slate-900'}
            />
            <GrowthTile
              label="Customers active (24h)"
              today={data.growth.customersActive24h}
              sevenDay={data.growth.customersActive7d}
              sevenDayLabel="7d unique"
            />
          </div>
        </section>

        <section>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">
            Paywall &amp; activation
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <GrowthTile
              label="Stuck at paywall"
              today={data.paywall.stuckAtPaywall}
              sevenDay={data.paywall.stuckAtPaywall}
              sevenDayLabel="awaiting card"
              valueColor={data.paywall.stuckAtPaywall > 0 ? 'text-amber-600' : 'text-slate-900'}
            />
            <GrowthTile
              label="Gate skips (today)"
              today={data.paywall.gateSkipsToday}
              sevenDay={data.paywall.gateSkipsToday}
              sevenDayLabel="classify + send"
            />
            <GrowthTile
              label="Un-pause blocked (today)"
              today={data.paywall.unpauseBlockedToday}
              sevenDay={data.paywall.unpauseBlockedToday}
              sevenDayLabel="no-sub attempts"
              valueColor={data.paywall.unpauseBlockedToday > 0 ? 'text-amber-600' : 'text-slate-900'}
            />
          </div>
        </section>

        <section>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">
            Billing &amp; revenue
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <TierDistributionTile dist={data.billing.tierDistribution} />
            <GrowthTile
              label="Subs canceled (7d)"
              today={data.billing.subsCanceled7d}
              sevenDay={data.billing.reactivations7d}
              sevenDayLabel="reactivations"
              valueColor={data.billing.subsCanceled7d > 0 ? 'text-red-600' : 'text-slate-900'}
            />
            <GrowthTile
              label="Invoice failures (today)"
              today={data.billing.invoiceFailedToday}
              sevenDay={data.billing.invoiceFailedToday}
              sevenDayLabel="dunning"
              valueColor={data.billing.invoiceFailedToday > 0 ? 'text-red-600' : 'text-slate-900'}
            />
            <GrowthTile
              label="Requires sales"
              today={data.billing.requiresSales}
              sevenDay={data.billing.requiresSales}
              sevenDayLabel="Enterprise backlog"
            />
          </div>
        </section>
      </div>
    </details>
  )
}

// ---------------------------------------------------------------------------
// Small reused pieces (counter, growth tile, tier breakdown, sparkline)
// ---------------------------------------------------------------------------

function Counter({
  label, value, customValue, sub, spark, tone = 'ok',
}: {
  label: string
  value: number
  customValue?: string
  sub?: string
  spark: number[]
  tone?: 'ok' | 'warn' | 'pop'
}) {
  const max = Math.max(1, ...spark)
  const toneClass = tone === 'warn' ? 'text-red-600' : tone === 'pop' ? 'text-green-600' : 'text-slate-900'
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">{label}</div>
      <div className={`text-xl font-bold ${toneClass}`}>{customValue ?? value.toLocaleString()}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
      <Sparkline values={spark} max={max} />
    </div>
  )
}

function GrowthTile({
  label, today, sevenDay, sevenDayLabel = 'last 7d', valueColor = 'text-slate-900',
}: {
  label: string
  today: number
  sevenDay: number
  sevenDayLabel?: string
  valueColor?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-2">
        <div className={`text-xl font-bold ${valueColor}`}>{today.toLocaleString()}</div>
        <div className="text-[10px] text-slate-400">
          today · {sevenDay.toLocaleString()} {sevenDayLabel}
        </div>
      </div>
    </div>
  )
}

function TierDistributionTile({
  dist,
}: {
  dist: { starter: number; growth: number; scale: number; enterprise: number; custom: number }
}) {
  const total = dist.starter + dist.growth + dist.scale + dist.enterprise + dist.custom
  const rows: Array<[string, number]> = [
    ['Starter',    dist.starter],
    ['Growth',     dist.growth],
    ['Scale',      dist.scale],
    ['Enterprise', dist.enterprise],
    ['Custom',     dist.custom],
  ]
  return (
    <div className="bg-white rounded-xl border border-slate-100 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1">Active subs by tier</div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <div className="text-xl font-bold">{total.toLocaleString()}</div>
        <div className="text-[10px] text-slate-400">active</div>
      </div>
      <div className="space-y-0.5">
        {rows.map(([label, n]) => (
          <div key={label} className="flex items-center justify-between text-[11px]">
            <span className="text-slate-500">{label}</span>
            <span className="tabular-nums text-slate-700 font-medium">{n.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Sparkline({ values, max }: { values: number[]; max: number }) {
  const blocks = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  return (
    <div className="font-mono text-blue-500 mt-2 leading-none text-[14px]">
      {values
        .map((v) => blocks[Math.min(blocks.length - 1, Math.floor((v / max) * (blocks.length - 1)))])
        .join('')}
    </div>
  )
}

function relTime(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

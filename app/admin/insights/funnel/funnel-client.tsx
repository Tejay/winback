'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { FunnelStages, formatCents } from '@/components/admin/metric-tiles'
import { RefreshAffordance } from '@/components/admin-refresh'

/**
 * /admin/insights/funnel — the 7-stage merchant acquisition funnel + a
 * per-drop-off "stuck merchants" list with a Send-nudge action. Mirrors the
 * insights-client pattern (window selector in URL, load-once, RefreshAffordance).
 */

type FunnelWindow = '7d' | '30d' | '90d' | 'all'

interface FunnelStage { key: string; label: string; value: number }
interface StuckMerchant {
  customerId: string
  founderName: string | null
  email: string | null
  daysStuck: number
  recoveredCents?: number
}
interface FunnelData {
  window: FunnelWindow
  stages: FunnelStage[]
  ctaByLocation: Array<{ location: string; count: number }>
  stuck: {
    registeredNotViewed: StuckMerchant[]
    viewedNotConnected: StuckMerchant[]
    connectedNotActivated: StuckMerchant[]
    activatedNotSubscribed: StuckMerchant[]
  }
}

type StuckStage = keyof FunnelData['stuck']

const WINDOW_OPTIONS: FunnelWindow[] = ['7d', '30d', '90d', 'all']

export function FunnelClient() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <FunnelInner />
    </Suspense>
  )
}

function FunnelInner() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const urlWindow = searchParams.get('window')
  const initialWindow: FunnelWindow = (WINDOW_OPTIONS as string[]).includes(urlWindow ?? '')
    ? (urlWindow as FunnelWindow)
    : '30d'

  const [window, setWindow] = useState<FunnelWindow>(initialWindow)
  const [data, setData] = useState<FunnelData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null)

  const load = useCallback(async (w: FunnelWindow) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/admin/funnel?window=${w}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Failed to load funnel')
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

  // Biggest single-step drop (lowest step conversion) for the callout.
  let biggestDrop: { from: string; to: string; pct: number } | null = null
  for (let i = 1; i < data.stages.length; i++) {
    const prev = data.stages[i - 1].value
    const cur = data.stages[i].value
    if (prev > 0) {
      const pct = Math.round((cur / prev) * 100)
      if (biggestDrop === null || pct < biggestDrop.pct) {
        biggestDrop = { from: data.stages[i - 1].label, to: data.stages[i].label, pct }
      }
    }
  }
  const top = data.stages[0]?.value ?? 0
  const bottom = data.stages[data.stages.length - 1]?.value ?? 0
  const overallPct = top > 0 ? ((bottom / top) * 100).toFixed(1) : '0'
  const totalCta = data.ctaByLocation.reduce((s, r) => s + r.count, 0)

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">Growth &amp; revenue</div>
          <h1 className="text-3xl font-bold text-slate-900">Acquisition funnel.</h1>
          <p className="text-sm text-slate-500">Where prospects drop off — and who&rsquo;s stuck so you can reach out.</p>
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

      {/* Funnel bar */}
      <section className="space-y-2">
        <FunnelStages stages={data.stages.map((s) => ({ label: s.label, value: s.value }))} />
        <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
          <span>Overall: <strong className="text-slate-600 tabular-nums">{top.toLocaleString()} → {bottom.toLocaleString()}</strong> · {overallPct}% land-to-paid</span>
          {biggestDrop && (
            <span className="text-rose-600 font-medium">Biggest drop: {biggestDrop.from} → {biggestDrop.to} ({biggestDrop.pct}%)</span>
          )}
        </div>
        <p className="text-[10px] text-slate-400 px-1">Stages 1–2 are anonymous visitor events (directional; may include bots). Stages 3–7 are merchants.</p>
      </section>

      {/* CTA by location */}
      {totalCta > 0 && (
        <section className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-3">CTA clicks by location · {totalCta.toLocaleString()}</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {data.ctaByLocation.map((r) => (
              <div key={r.location} className="rounded-xl bg-slate-50 p-3">
                <div className="text-lg font-bold tabular-nums">{r.count.toLocaleString()}</div>
                <div className="text-xs text-slate-500">{r.location}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Stuck merchants */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-900">Stuck merchants <span className="text-slate-400 font-normal text-sm">· reach out</span></h2>
        <StuckCard
          title="Reached connect screen, didn't connect"
          stage="viewedNotConnected"
          rows={data.stuck.viewedNotConnected}
        />
        <StuckCard
          title="Registered, never reached connect screen"
          stage="registeredNotViewed"
          rows={data.stuck.registeredNotViewed}
          note="check the post-signup redirect if this is non-zero"
          noteTone="amber"
        />
        <StuckCard
          title="Connected, no first recovery"
          stage="connectedNotActivated"
          rows={data.stuck.connectedNotActivated}
          note="often legit — awaiting first churn"
          noteTone="amber"
        />
        <StuckCard
          title="Activated, not subscribed"
          stage="activatedNotSubscribed"
          rows={data.stuck.activatedNotSubscribed}
          note="stuck at paywall — hot"
          noteTone="rose"
          showRecovered
        />
      </section>
    </div>
  )
}

function StuckCard({
  title, stage, rows, note, noteTone = 'amber', showRecovered = false,
}: {
  title: string
  stage: StuckStage
  rows: StuckMerchant[]
  note?: string
  noteTone?: 'amber' | 'rose'
  showRecovered?: boolean
}) {
  const noteCls = noteTone === 'rose'
    ? 'text-rose-700 bg-rose-50 border-rose-200'
    : 'text-amber-700 bg-amber-50 border-amber-200'
  return (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-900">{title} <span className="text-slate-400 font-normal">· {rows.length}</span></div>
        {note && <span className={`text-[11px] border rounded-full px-2 py-0.5 ${noteCls}`}>{note}</span>}
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400">None — nobody stuck here.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 bg-slate-50/60">
              <th className="py-2 pl-5 pr-4">Merchant</th>
              <th className="px-4">Email</th>
              <th className="px-4">Stuck</th>
              {showRecovered && <th className="px-4">Recovered</th>}
              <th className="px-4 text-right pr-5">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {rows.map((r) => (
              <tr key={r.customerId}>
                <td className="py-3 pl-5 pr-4 font-medium text-slate-900">{r.founderName ?? '—'}</td>
                <td className="px-4 text-slate-600">{r.email ?? '—'}</td>
                <td className="px-4 text-slate-600 tabular-nums">{r.daysStuck} day{r.daysStuck === 1 ? '' : 's'}</td>
                {showRecovered && <td className="px-4 text-emerald-700 font-medium tabular-nums">{formatCents(r.recoveredCents ?? 0)}</td>}
                <td className="px-4 text-right pr-5 whitespace-nowrap">
                  <Link href={`/admin/customers/${r.customerId}`} className="text-blue-600 text-xs mr-3 hover:underline">Open ↗</Link>
                  <NudgeButton customerId={r.customerId} stage={stage} disabled={!r.email} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function NudgeButton({ customerId, stage, disabled }: { customerId: string; stage: StuckStage; disabled?: boolean }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'skipped' | 'error'>('idle')
  const [msg, setMsg] = useState<string>('')

  async function send() {
    if (state === 'sending' || state === 'sent') return
    setState('sending')
    try {
      const res = await fetch(`/api/admin/customers/${customerId}/nudge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage }),
      })
      const json = await res.json().catch(() => ({}))
      if (res.ok && json.ok) { setState('sent') }
      else if (json.skipped) { setState('skipped'); setMsg(json.skipped === 'recently_nudged' ? 'recently nudged' : json.skipped === 'opted_out' ? 'opted out' : 'no email') }
      else { setState('error'); setMsg(json.error ?? 'failed') }
    } catch {
      setState('error'); setMsg('failed')
    }
  }

  if (state === 'sent') return <span className="inline-block bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full px-3 py-1 text-xs font-medium">nudged ✓</span>
  if (state === 'skipped') return <span className="inline-block bg-slate-50 text-slate-500 border border-slate-200 rounded-full px-3 py-1 text-xs">{msg}</span>
  if (state === 'error') return <button onClick={send} className="bg-red-50 text-red-700 border border-red-200 rounded-full px-3 py-1 text-xs font-medium">retry ({msg})</button>
  return (
    <button
      onClick={send}
      disabled={disabled || state === 'sending'}
      className="bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-full px-3 py-1 text-xs font-medium"
      title={disabled ? 'No contact email on file' : undefined}
    >
      {state === 'sending' ? 'Sending…' : 'Send nudge'}
    </button>
  )
}

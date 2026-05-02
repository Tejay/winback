'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { AiStateBadge } from '@/components/ai-state-badge'
import { TrendingUp, CheckCircle, DollarSign, Users, Search, Zap, X, RotateCcw, Check, Loader2, Sparkles, MessageSquare, CreditCard } from 'lucide-react'

interface Subscriber {
  id: string
  name: string | null
  email: string | null
  planName: string | null
  cancelledAt: string | null
  cancellationReason: string | null
  cancellationCategory: string | null
  status: string
  mrrCents: number
  tenureDays: number | null
  stripeEnum: string | null
  stripeComment: string | null
  replyText: string | null
  triggerKeyword: string | null
  triggerNeed: string | null
  tier: number | null
  confidence: string | null
  winBackSubject: string | null
  winBackBody: string | null
  attributionType: string | null
  // Spec 21b — handoff state
  founderHandoffAt: string | null
  founderHandoffResolvedAt: string | null
  // Spec 22a — AI pause (replaces founderHandoffSnoozedUntil)
  aiPausedUntil: string | null
  aiPausedAt: string | null
  aiPausedReason: string | null
  // Spec 21a
  doNotContact?: boolean | null
  // Migration 017 — AI-decided hand-off judgment, persisted on every
  // classification pass (not just when hand-off fires). Lets the founder
  // see WHY the AI made the call it made.
  handoffReasoning: string | null
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
  // Spec 40 — dunning fields surfaced on the payment-recovery tab.
  dunningState: 'awaiting_retry' | 'final_retry_pending' | 'churned_during_dunning' | 'recovered_during_dunning' | null
  dunningTouchCount: number | null
  dunningLastTouchAt: string | null
  nextPaymentAttemptAt: string | null
  lastDeclineCode: string | null
  // The webhook never sets cancelledAt for payment-failed rows, so the
  // payment-recovery tab uses createdAt as the "failed at" anchor (the
  // moment the failure was first observed).
  createdAt: string | null
}

// Spec 39/40 — KPIs split by recovery type and time window plus
// Spec 40 attention/pattern fields (handoff alert, top reasons,
// MRR-at-risk, on-final-attempt count, top decline codes).
interface Bucket {
  recovered: number
  mrrRecoveredCents: number
}
interface LabelPct {
  label: string
  pct: number
}
interface WinBackFilterCounts {
  all: number
  handoff: number
  'has-reply': number
  paused: number
  recovered: number
  done: number
}
interface PaymentFilterCounts {
  all: number
  'in-retry': number
  'final-retry': number
  recovered: number
  lost: number
}
interface Stats {
  // Spec 41 — same lifetime number on both cohorts (cached on the customer row).
  cumulativeRevenueSavedCents: number
  cumulativeRevenueLastComputedAt: string | null
  winBack: {
    thisMonth: Bucket
    lastMonth: Bucket
    allTime: Bucket & { recoveryRate: number | null }
    inProgress: number
    handoffsNeedingAttention: number
    topReasons: LabelPct[]
    filterCounts: WinBackFilterCounts
    dailyRecovered: number[]
  }
  paymentRecovery: {
    thisMonth: Bucket
    lastMonth: Bucket
    allTime: Bucket & { recoveryRate: number | null }
    inDunning: number
    topDeclineCodes: LabelPct[]
    filterCounts: PaymentFilterCounts
    dailyRecovered: number[]
  }
}

const EMPTY_BUCKET: Bucket = { recovered: 0, mrrRecoveredCents: 0 }
const EMPTY_STATS: Stats = {
  cumulativeRevenueSavedCents: 0,
  cumulativeRevenueLastComputedAt: null,
  winBack: {
    thisMonth: EMPTY_BUCKET,
    lastMonth: EMPTY_BUCKET,
    allTime: { recovered: 0, mrrRecoveredCents: 0, recoveryRate: null },
    inProgress: 0,
    handoffsNeedingAttention: 0,
    topReasons: [],
    filterCounts: { all: 0, handoff: 0, 'has-reply': 0, paused: 0, recovered: 0, done: 0 },
    dailyRecovered: [],
  },
  paymentRecovery: {
    thisMonth: EMPTY_BUCKET,
    lastMonth: EMPTY_BUCKET,
    allTime: { recovered: 0, mrrRecoveredCents: 0, recoveryRate: null },
    inDunning: 0,
    topDeclineCodes: [],
    filterCounts: { all: 0, 'in-retry': 0, 'final-retry': 0, recovered: 0, lost: 0 },
    dailyRecovered: [],
  },
}

interface BackfillStatus {
  total: number
  processed: number
  complete: boolean
  startedAt: string | null
  completedAt: string | null
  lostMrrCents: number
  contacted: number
  skipped: number
}

interface DashboardClientProps {
  changelog: string
  isTrial: boolean
  firstRecovery: { name: string | null; mrrCents: number } | null
  /** Spec 31 — ISO string of pilot_until if the customer is currently on
   *  pilot, null otherwise. Drives the pilot banner that replaces the
   *  generic "billing inactive" prompt. */
  pilotUntilIso?: string | null
}

export function DashboardClient({
  changelog,
  isTrial,
  firstRecovery,
  pilotUntilIso = null,
}: DashboardClientProps) {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)
  const [subscribers, setSubscribers] = useState<Subscriber[]>([])
  // Spec 40 — independent filter/search state per cohort tab.
  type Cohort = 'winback' | 'paymentRecovery'
  const [tab, setTab] = useState<Cohort>('winback')
  const [winbackFilter, setWinbackFilter] = useState('all')
  const [winbackSearch, setWinbackSearch] = useState('')
  const [paymentFilter, setPaymentFilter] = useState('all')
  const [paymentSearch, setPaymentSearch] = useState('')
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null)
  const filter = tab === 'winback' ? winbackFilter : paymentFilter
  const setFilter = tab === 'winback' ? setWinbackFilter : setPaymentFilter
  const search = tab === 'winback' ? winbackSearch : paymentSearch
  const setSearch = tab === 'winback' ? setWinbackSearch : setPaymentSearch
  const [selected, setSelected] = useState<Subscriber | null>(null)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [changelogText, setChangelogText] = useState(changelog)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [backfill, setBackfill] = useState<BackfillStatus | null>(null)
  const [backfillBannerDismissed, setBackfillBannerDismissed] = useState(false)
  const [changelogNudgeDismissed, setChangelogNudgeDismissed] = useState(false)

  useEffect(() => {
    const dismissed = localStorage.getItem('winback_banner_dismissed')
    if (dismissed) setBannerDismissed(true)
    const bfDismissed = localStorage.getItem('winback_backfill_dismissed')
    if (bfDismissed) setBackfillBannerDismissed(true)
    const clDismissed = localStorage.getItem('winback_changelog_nudge_dismissed')
    if (clDismissed) setChangelogNudgeDismissed(true)
  }, [])

  // Poll backfill status while in progress.
  // Spec 40 polish — visibility-gated: pause the poll when the tab is in
  // background. Backfill rarely completes within a single foreground
  // session anyway, and a hidden tab polling every 3s burns Neon
  // connections for nothing. Resumes on visibilitychange → 'visible'.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    let stopped = false

    function pollBackfill() {
      if (document.visibilityState !== 'visible') return
      fetch('/api/backfill/status')
        .then((r) => r.json())
        .then((data: BackfillStatus) => {
          setBackfill(data)
          if (data.complete) {
            stopped = true
            if (interval) {
              clearInterval(interval)
              interval = null
            }
            fetchData()
          }
        })
        .catch(() => {})
    }

    function startInterval() {
      if (stopped || interval) return
      pollBackfill() // fire once immediately
      interval = setInterval(pollBackfill, 3000)
    }

    function stopInterval() {
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    }

    function onVisibilityChange() {
      if (stopped) return
      if (document.visibilityState === 'visible') startInterval()
      else stopInterval()
    }

    if (document.visibilityState === 'visible') startInterval()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      stopInterval()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchData = useCallback(() => {
    fetch('/api/stats').then((r) => r.json()).then(setStats)
    const params = new URLSearchParams()
    // Spec 40 — partition by cohort. The "Has reply" chip is win-back-only
    // and serialised to ?hasReply=true rather than the filter slot so the
    // existing AI-state filter pipeline stays clean.
    params.set('cohort', tab === 'winback' ? 'winback' : 'payment-recovery')
    if (filter === 'has-reply') {
      params.set('hasReply', 'true')
    } else if (filter !== 'all') {
      params.set('filter', filter)
    }
    if (search) params.set('search', search)
    fetch(`/api/subscribers?${params}`).then((r) => r.json()).then(setSubscribers)
  }, [tab, filter, search])

  useEffect(() => { fetchData() }, [fetchData])

  // Spec 40 — switching tabs closes any open per-row UI on the previous tab:
  // collapse expanded payment-recovery row, close the win-back drawer.
  useEffect(() => {
    setExpandedRowId(null)
    setSelected(null)
  }, [tab])

  function dismissBanner() {
    setBannerDismissed(true)
    localStorage.setItem('winback_banner_dismissed', 'true')
  }

  async function saveChangelog() {
    await fetch('/api/changelog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: changelogText }),
    })
    setChangelogOpen(false)
  }

  async function handleAction(id: string, action: 'resend' | 'recover') {
    await fetch(`/api/subscribers/${id}/${action}`, { method: 'POST' })
    setSelected(null)
    fetchData()
  }

  // Spec 21c — legacy snooze/resolve (handoff-specific buttons on amber banner)
  async function handleHandoffAction(
    id: string,
    action: 'snooze' | 'resolve',
    durationDays?: number,
  ) {
    await fetch(`/api/subscribers/${id}/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'snooze' ? { action, durationDays } : { action }),
    })
    setSelected(null)
    fetchData()
  }

  // Spec 22a — unified pause/resume on any subscriber
  async function handlePauseAction(
    id: string,
    action: 'pause' | 'resume',
    durationDays?: number | null,
    reason?: string,
  ) {
    const body = action === 'pause'
      ? { action, durationDays: durationDays ?? null, reason: reason ?? 'founder_handling' }
      : { action }
    await fetch(`/api/subscribers/${id}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSelected(null)
    fetchData()
  }

  // Spec 22b + Spec 40 — AI-state filters for win-back cohort, dunning-
  // state filters for payment-recovery cohort. Each tab keeps its own
  // filter state so switching tabs doesn't lose context.
  const winbackFilters: Array<{ key: string; label: string }> = [
    { key: 'all',       label: 'All' },
    { key: 'handoff',   label: 'Needs you' },
    { key: 'has-reply', label: 'Has reply' },
    { key: 'paused',    label: 'Paused' },
    { key: 'recovered', label: 'Recovered' },
    { key: 'done',      label: 'Done' },
  ]
  const paymentFilters: Array<{ key: string; label: string }> = [
    { key: 'all',         label: 'All' },
    { key: 'in-retry',    label: 'In retry' },
    { key: 'final-retry', label: 'Final retry' },
    { key: 'recovered',   label: 'Recovered' },
    { key: 'lost',        label: 'Lost' },
  ]
  const filters = tab === 'winback' ? winbackFilters : paymentFilters
  // Spec 31 — pilot banner replaces the "add billing" banner while the
  // founder is on a free pilot. We don't ask them for a card during the
  // pilot window, and the bypass gates won't bill them anyway.
  const onPilot = !!pilotUntilIso
  const pilotEndsOn = pilotUntilIso ? new Date(pilotUntilIso) : null
  const pilotDaysLeft = pilotEndsOn
    ? Math.max(0, Math.ceil((pilotEndsOn.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : 0
  const showBanner = !onPilot && isTrial && firstRecovery && !bannerDismissed

  return (
    <>
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-6">
        <div>
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">Overview</div>
          <h1 className="text-4xl font-bold text-slate-900">Dashboard.</h1>
          <p className="text-sm text-slate-500 mt-1">Every cancellation, every recovery — all in one view.</p>
        </div>
        <button
          onClick={() => setChangelogOpen(true)}
          className="self-start border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium flex-shrink-0"
        >
          Update changelog
        </button>
      </div>

      {/* Spec 31 — pilot banner */}
      {onPilot && pilotEndsOn && (
        <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 mb-6 flex items-start gap-4">
          <div className="bg-white rounded-full p-2 flex-shrink-0 text-xl leading-none">
            🚀
          </div>
          <div>
            <p className="text-sm font-medium text-slate-900">
              Pilot — until {pilotEndsOn.toLocaleDateString('en-GB', {
                day: 'numeric', month: 'long', year: 'numeric',
              })}
              {' '}({pilotDaysLeft} {pilotDaysLeft === 1 ? 'day' : 'days'} remaining)
            </p>
            <p className="text-sm text-slate-600 mt-1">
              No charges during the pilot — no platform fee, no recovery
              fees. We&apos;ll email you a heads-up 7 days before normal
              billing kicks in.
            </p>
          </div>
        </div>
      )}

      {/* Billing alert — Spec 40 polish: slide-in animation + CSS confetti
          burst the first time it mounts. Only fires for trial accounts on
          first-recovery; after that the user dismisses it and never sees
          it again (localStorage-gated). */}
      {showBanner && (
        <FirstRecoveryBanner
          firstRecovery={firstRecovery!}
          onDismiss={dismissBanner}
        />
      )}

      {/* Backfill banner */}
      {backfill && backfill.startedAt && !backfillBannerDismissed && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6">
          {!backfill.complete ? (
            <div className="flex items-start gap-4">
              <div className="bg-blue-50 rounded-full p-2 flex-shrink-0">
                <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-900">
                  Reviewing your cancellation history...
                </p>
                <p className="text-sm text-slate-500 mt-1">
                  Found {backfill.total} cancelled subscriber{backfill.total !== 1 ? 's' : ''} so far.
                  Winback is reviewing each one — we&apos;ll only reach out where it makes sense.
                </p>
                {backfill.total > 0 && (
                  <div className="mt-3">
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full transition-all duration-500"
                        style={{ width: `${Math.round((backfill.processed / backfill.total) * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      {backfill.processed} / {backfill.total} reviewed
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className="bg-green-50 rounded-full p-2 flex-shrink-0">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    We found {backfill.total} cancelled subscriber{backfill.total !== 1 ? 's' : ''} — £{Math.round(backfill.lostMrrCents / 100).toLocaleString()}/mo in lost revenue.
                  </p>
                  <p className="text-sm text-slate-500 mt-1">
                    Winback contacted {backfill.contacted} where a recovery looked possible.
                    {backfill.skipped > 0 && ` ${backfill.skipped} were too old or unlikely to convert.`}
                    {' '}New cancellations will be recovered automatically from here.
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setBackfillBannerDismissed(true)
                  localStorage.setItem('winback_backfill_dismissed', 'true')
                }}
                className="text-slate-400 hover:text-slate-600 flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Changelog empty-state nudge */}
      {!changelogText.trim() && subscribers.length > 0 && !changelogNudgeDismissed && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6 flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="bg-blue-50 rounded-full p-2 flex-shrink-0">
              <Sparkles className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-900">
                Add what you&apos;ve shipped recently
              </p>
              <p className="text-sm text-slate-500 mt-1">
                Winback uses your changelog to write win-back emails that reference the exact thing a subscriber asked for. Takes 30 seconds — one line per shipment.
              </p>
              <button
                onClick={() => setChangelogOpen(true)}
                className="mt-3 bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
              >
                Add what you&apos;ve shipped →
              </button>
            </div>
          </div>
          <button
            onClick={() => {
              setChangelogNudgeDismissed(true)
              localStorage.setItem('winback_changelog_nudge_dismissed', 'true')
            }}
            className="text-slate-400 hover:text-slate-600 flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Spec 40 — tab strip at top of the cohort area. Pill-button style
          (filled in the cohort color when active) so the cohort split is
          immediately legible, including in marketing screenshots. */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => setTab('winback')}
          className={
            tab === 'winback'
              ? 'flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold bg-blue-600 text-white shadow-sm'
              : 'flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors'
          }
        >
          <MessageSquare className="w-4 h-4" />
          Win-backs
        </button>
        <button
          onClick={() => setTab('paymentRecovery')}
          className={
            tab === 'paymentRecovery'
              ? 'flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold bg-[#047857] text-white shadow-sm'
              : 'flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors'
          }
        >
          <CreditCard className="w-4 h-4" />
          Payment recoveries
        </button>
      </div>

      {/* Spec 40 — Win-back tab: KPI row, attention alert, pattern strip */}
      {tab === 'winback' && (
        <>
          {/* KPI row — blue tint background */}
          <section className="rounded-3xl bg-blue-100 border border-blue-200 p-3 mb-7">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              <StatCard
                accent="blue"
                icon={<TrendingUp className="w-4 h-4" />}
                value={stats.winBack.allTime.recoveryRate === null ? '—' : `${stats.winBack.allTime.recoveryRate}%`}
                label="Recovery rate (30d)"
              />
              <StatCard
                accent="blue"
                icon={<CheckCircle className="w-4 h-4" />}
                value={String(stats.winBack.allTime.recovered)}
                label="Recovered"
                delta={formatDelta(
                  stats.winBack.thisMonth.recovered,
                  stats.winBack.lastMonth.recovered,
                  'count',
                )}
                sparkline={stats.winBack.dailyRecovered}
              />
              <StatCard
                accent="blue"
                icon={<DollarSign className="w-4 h-4" />}
                value={`$${Math.round(stats.cumulativeRevenueSavedCents / 100).toLocaleString()}`}
                subValue={`$${Math.round(stats.winBack.allTime.mrrRecoveredCents / 100).toLocaleString()}/mo currently active`}
                label="Revenue saved · lifetime"
                delta={formatDelta(
                  stats.winBack.thisMonth.mrrRecoveredCents,
                  stats.winBack.lastMonth.mrrRecoveredCents,
                  'money',
                )}
              />
              <StatCard
                accent="amber"
                icon={<Users className="w-4 h-4" />}
                value={String(stats.winBack.inProgress)}
                label="In progress"
              />
            </div>
          </section>
          {stats.winBack.handoffsNeedingAttention > 0 && (
            <div className="mb-4 flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="bg-amber-100 text-amber-700 rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold">
                  !
                </span>
                <span className="font-medium text-amber-900">
                  {stats.winBack.handoffsNeedingAttention} subscriber{stats.winBack.handoffsNeedingAttention === 1 ? '' : 's'} need{stats.winBack.handoffsNeedingAttention === 1 ? 's' : ''} your attention
                </span>
              </div>
              <button
                onClick={() => setWinbackFilter('handoff')}
                className="text-sm font-medium text-amber-900 hover:text-amber-700"
              >
                Resolve queue →
              </button>
            </div>
          )}
          {stats.winBack.topReasons.length > 0 && (
            <PatternPills items={stats.winBack.topReasons} />
          )}
        </>
      )}

      {/* Spec 40 — Payment-recovery tab: KPI row, summary band, pattern strip */}
      {tab === 'paymentRecovery' && (
        <>
          {/* KPI row — green tint background */}
          <section className="rounded-3xl bg-green-100 border border-green-200 p-3 mb-7">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              <StatCard
                accent="green"
                icon={<TrendingUp className="w-4 h-4" />}
                value={stats.paymentRecovery.allTime.recoveryRate === null ? '—' : `${stats.paymentRecovery.allTime.recoveryRate}%`}
                label="Recovery rate (30d)"
              />
              <StatCard
                accent="green"
                icon={<CheckCircle className="w-4 h-4" />}
                value={String(stats.paymentRecovery.allTime.recovered)}
                label="Recovered"
                delta={formatDelta(
                  stats.paymentRecovery.thisMonth.recovered,
                  stats.paymentRecovery.lastMonth.recovered,
                  'count',
                )}
                sparkline={stats.paymentRecovery.dailyRecovered}
              />
              <StatCard
                accent="green"
                icon={<DollarSign className="w-4 h-4" />}
                value={`$${Math.round(stats.cumulativeRevenueSavedCents / 100).toLocaleString()}`}
                subValue={`$${Math.round(stats.paymentRecovery.allTime.mrrRecoveredCents / 100).toLocaleString()}/mo currently active`}
                label="Revenue saved · lifetime"
                delta={formatDelta(
                  stats.paymentRecovery.thisMonth.mrrRecoveredCents,
                  stats.paymentRecovery.lastMonth.mrrRecoveredCents,
                  'money',
                )}
              />
              <StatCard
                accent="amber"
                icon={<Users className="w-4 h-4" />}
                value={String(stats.paymentRecovery.inDunning)}
                label="In dunning"
              />
            </div>
          </section>

          {stats.paymentRecovery.topDeclineCodes.length > 0 && (
            <PatternPills items={stats.paymentRecovery.topDeclineCodes} />
          )}
        </>
      )}

      {/* Filter chips + search (per-tab state) */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4 mb-4">
        <div className="flex items-center gap-1 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
          {filters.map((f) => {
            const counts = (tab === 'winback'
              ? stats.winBack.filterCounts
              : stats.paymentRecovery.filterCounts) as unknown as Record<string, number>
            const count = counts[f.key]
            const active = filter === f.key
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={
                  active
                    ? 'flex items-center gap-1.5 bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium'
                    : 'flex items-center gap-1.5 text-slate-500 hover:text-slate-900 rounded-full px-4 py-1.5 text-sm font-medium transition-colors'
                }
              >
                <span>{f.label}</span>
                {count !== undefined && count > 0 && (
                  <span
                    className={
                      active
                        ? 'tabular-nums text-white/70 text-xs'
                        : 'tabular-nums text-slate-400 text-xs'
                    }
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
        <div className="relative w-full md:w-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder={tab === 'winback' ? 'Search name, email, reason' : 'Search name, email, decline code'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-slate-200 rounded-full px-4 py-2 text-sm w-full md:w-64 pl-10 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Subscriber table — per-tab columns + interaction model */}
      {tab === 'winback' ? (
        <div className="bg-white rounded-2xl border border-slate-100 overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Subscriber</th>
                <th className="hidden lg:table-cell text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Plan</th>
                <th className="hidden sm:table-cell text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Cancelled</th>
                <th className="hidden md:table-cell text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Reason</th>
                <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">AI Status</th>
                <th className="text-right text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">MRR</th>
              </tr>
            </thead>
            <tbody>
              {subscribers.map((sub) => (
                <tr
                  key={sub.id}
                  onClick={() => setSelected(sub)}
                  className="hover:bg-slate-50 cursor-pointer border-b border-slate-50 transition-colors"
                >
                  <td className="py-4 pr-4 px-4">
                    <div className="text-sm font-medium text-slate-900">{sub.name ?? 'Unknown'}</div>
                    <div className="text-xs text-slate-400 mt-0.5 truncate max-w-[160px] sm:max-w-none">{sub.email ?? ''}</div>
                  </td>
                  <td className="hidden lg:table-cell text-sm text-slate-600 py-4 px-4">{sub.planName ?? '—'}</td>
                  <td className="hidden sm:table-cell text-sm text-slate-600 py-4 px-4">
                    {sub.cancelledAt ? new Date(sub.cancelledAt).toISOString().split('T')[0] : '—'}
                  </td>
                  <td className="hidden md:table-cell text-sm text-slate-600 py-4 px-4">
                    {sub.cancellationReason
                      ? sub.cancellationReason.length > 45
                        ? sub.cancellationReason.slice(0, 45) + '…'
                        : sub.cancellationReason
                      : '—'}
                  </td>
                  <td className="py-4 px-4">
                    <AiStateBadge sub={sub} compact />
                  </td>
                  <td className="text-sm font-medium text-slate-900 py-4 px-4 text-right">
                    ${(sub.mrrCents / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
              {subscribers.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-sm text-slate-400">
                    No win-backs yet. Cancellations land here as they come in from Stripe.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <PaymentRecoveryTable
          rows={subscribers}
          expandedRowId={expandedRowId}
          onToggleExpand={(id) => setExpandedRowId((current) => (current === id ? null : id))}
          onResendDunning={async (id) => {
            await fetch(`/api/subscribers/${id}/resend`, { method: 'POST' })
            fetchData()
          }}
        />
      )}

      {/* Subscriber detail panel */}
      {selected && (
        <>
          <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setSelected(null)} />
          <div className="fixed right-0 top-0 h-full w-full sm:w-96 bg-white shadow-xl border-l border-slate-100 z-50 overflow-y-auto">
            <div className="px-6 pt-6 pb-4 border-b border-slate-100 flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Subscriber</div>
                <div className="text-xl font-bold text-slate-900">{selected.name ?? 'Unknown'}</div>
              </div>
              <button onClick={() => setSelected(null)} className="text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <StatusBadge status={selected.status as 'pending' | 'contacted' | 'recovered' | 'lost' | 'skipped'} />
                {selected.status === 'recovered' && selected.attributionType && (
                  <span className={`text-xs font-medium ${
                    selected.attributionType === 'strong'
                      ? 'text-green-600'
                      : 'text-blue-600'
                  }`}>
                    {selected.attributionType === 'strong' ? '— via Winback link' : '— resubscribed organically'}
                  </span>
                )}
              </div>
              <div className="text-right">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400">MRR</div>
                <div className="text-xl font-bold text-slate-900">${(selected.mrrCents / 100).toFixed(2)}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 px-6">
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Email</div>
                <div className="text-sm font-medium text-slate-900 truncate">{selected.email ?? '—'}</div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Plan</div>
                <div className="text-sm font-medium text-slate-900">{selected.planName ?? '—'}</div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Cancelled</div>
                <div className="text-sm font-medium text-slate-900">
                  {selected.cancelledAt ? new Date(selected.cancelledAt).toISOString().split('T')[0] : '—'}
                </div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3">
                <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Tenure</div>
                <div className="text-sm font-medium text-slate-900">
                  {selected.tenureDays != null
                    ? selected.tenureDays >= 30
                      ? `${Math.round(selected.tenureDays / 30)} months`
                      : `${selected.tenureDays} days`
                    : '—'}
                </div>
              </div>
            </div>

            {/* Spec 40 polish — Why they cancelled, side-by-side.
                Left: what the customer typed in Stripe's cancel flow
                  (stripeComment / stripeEnum) — the raw voice.
                Right: how the AI interpreted that into our internal
                  cancellationReason + category + tier.
                Lets the founder spot-check whether the AI's read
                matches what the customer actually said. */}
            {(selected.cancellationReason || selected.stripeComment || selected.stripeEnum) && (
              <div className="mx-6 mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">
                    What they said
                  </div>
                  {selected.stripeEnum && (
                    <div className="inline-flex items-center text-[11px] font-mono px-2 py-0.5 rounded bg-slate-200/70 text-slate-700 mb-2">
                      {selected.stripeEnum}
                    </div>
                  )}
                  {selected.stripeComment ? (
                    <div className="text-sm text-slate-700 italic leading-relaxed">
                      &ldquo;{selected.stripeComment}&rdquo;
                    </div>
                  ) : !selected.stripeEnum ? (
                    <div className="text-xs text-slate-400 italic">
                      Customer left no comment in Stripe&apos;s cancel flow.
                    </div>
                  ) : null}
                </div>
                <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
                  <div className="flex items-center justify-between mb-2 gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-blue-600">
                      What we heard
                    </div>
                    {selected.tier != null && (
                      <span className="inline-flex items-center rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-0.5">
                        T{selected.tier}
                      </span>
                    )}
                  </div>
                  {selected.cancellationReason && (
                    <div className="text-sm font-medium text-slate-900 mb-1">
                      {selected.cancellationReason}
                    </div>
                  )}
                  {selected.cancellationCategory && (
                    <div className="text-xs text-slate-500">
                      Category: <span className="text-slate-700 font-medium">{selected.cancellationCategory}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Spec 40 polish — Trigger need. The LLM-extracted product gap
                that, if shipped, would win this customer back. Drives the
                changelog-match feature. Worth surfacing prominently because
                this is *why* the win-back system has any standing power
                beyond the immediate exit email. */}
            {selected.triggerNeed && (
              <div className="mx-6 mt-4 bg-violet-50 rounded-xl p-4 border border-violet-100">
                <div className="flex items-start gap-3">
                  <div className="bg-violet-100 rounded-lg w-8 h-8 flex items-center justify-center text-violet-700 flex-shrink-0 mt-0.5">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-violet-700 mb-1">
                      What would win them back
                    </div>
                    <div className="text-sm text-slate-800 italic leading-relaxed">
                      &ldquo;{selected.triggerNeed}&rdquo;
                    </div>
                    <div className="text-[11px] text-violet-700/70 mt-2">
                      We&apos;ll auto-fire a win-back when your changelog mentions{' '}
                      {selected.triggerKeyword ? (
                        <span className="font-mono bg-violet-100 px-1 py-0.5 rounded">
                          {selected.triggerKeyword}
                        </span>
                      ) : (
                        <span>this</span>
                      )}.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Migration 017 — AI judgment panel. Renders on every subscriber
                that's been classified, not just handed-off ones, so you can
                see why the AI escalated / kept going / closed out. */}
            {(selected.handoffReasoning || selected.recoveryLikelihood) && (
              <div className="mx-6 mt-4 bg-slate-50 rounded-xl p-4 border border-slate-100">
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                    AI Judgment
                  </div>
                  {selected.recoveryLikelihood && (
                    <span
                      className={`text-xs font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${
                        selected.recoveryLikelihood === 'high'
                          ? 'bg-green-50 text-green-700 border-green-200'
                          : selected.recoveryLikelihood === 'medium'
                            ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : 'bg-slate-100 text-slate-500 border-slate-200'
                      }`}
                    >
                      Recovery: {selected.recoveryLikelihood}
                    </span>
                  )}
                </div>
                {selected.handoffReasoning ? (
                  <p className="text-sm text-slate-700 italic leading-relaxed">
                    &ldquo;{selected.handoffReasoning}&rdquo;
                  </p>
                ) : (
                  <p className="text-xs text-slate-400 italic">No reasoning persisted yet.</p>
                )}
              </div>
            )}

            <div className="px-6 mt-5">
              <div className="text-sm font-semibold text-slate-900 mb-3">Email history</div>
              <p className="text-sm text-slate-400">
                No emails sent yet. Winback will send the first one automatically.
              </p>
            </div>

            <div className="px-6 mt-5 pt-5 border-t border-slate-100 pb-6">
              {/* Spec 21b/22a — handoff status banner */}
              {selected.founderHandoffAt && !selected.founderHandoffResolvedAt && (
                <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                  <div className="text-xs font-semibold uppercase tracking-wider text-amber-800 mb-1">
                    Founder action needed
                  </div>
                  <p className="text-sm text-slate-700 mb-3">
                    AI follow-ups exhausted. {selected.aiPausedUntil &&
                      new Date(selected.aiPausedUntil).getTime() > Date.now() &&
                      new Date(selected.aiPausedUntil).getFullYear() < 2099
                      ? `Snoozed until ${new Date(selected.aiPausedUntil).toLocaleDateString()}.`
                      : 'Reply to them directly — see your inbox for the alert with mailto link.'}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => handleHandoffAction(selected.id, 'snooze', 1)}
                      className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1 text-xs font-medium hover:bg-slate-50"
                    >
                      Pause 1 day
                    </button>
                    <button
                      onClick={() => handleHandoffAction(selected.id, 'snooze', 7)}
                      className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1 text-xs font-medium hover:bg-slate-50"
                    >
                      Pause 1 week
                    </button>
                    <button
                      onClick={() => handleHandoffAction(selected.id, 'resolve')}
                      className="bg-[#0f172a] text-white rounded-full px-3 py-1 text-xs font-medium hover:bg-[#1e293b]"
                    >
                      Mark resolved
                    </button>
                  </div>
                </div>
              )}

              {/* Spec 22a — proactive pause banner (non-handoff) */}
              {(!selected.founderHandoffAt || selected.founderHandoffResolvedAt) &&
                selected.aiPausedUntil &&
                new Date(selected.aiPausedUntil).getTime() > Date.now() && (
                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-xl">
                  <div className="text-xs font-semibold uppercase tracking-wider text-blue-800 mb-1">
                    AI paused
                  </div>
                  <p className="text-sm text-slate-700 mb-3">
                    {new Date(selected.aiPausedUntil).getFullYear() >= 2099
                      ? 'Paused indefinitely.'
                      : `Paused until ${new Date(selected.aiPausedUntil).toLocaleDateString()}.`}
                    {selected.aiPausedReason && selected.aiPausedReason !== 'handoff' && (
                      <span className="text-slate-500"> · {selected.aiPausedReason.replace(/_/g, ' ')}</span>
                    )}
                  </p>
                  <button
                    onClick={() => handlePauseAction(selected.id, 'resume')}
                    className="bg-[#0f172a] text-white rounded-full px-3 py-1 text-xs font-medium hover:bg-[#1e293b]"
                  >
                    Resume AI
                  </button>
                </div>
              )}

              {selected.status !== 'recovered' && selected.status !== 'lost' && (
                <div className="flex gap-3 mb-3">
                  <button
                    onClick={() => handleAction(selected.id, 'resend')}
                    className="flex-1 border border-slate-200 bg-white text-slate-700 rounded-full px-4 py-2 text-sm font-medium flex items-center justify-center gap-1.5"
                  >
                    <RotateCcw className="w-3.5 h-3.5" /> Resend
                  </button>
                  <button
                    onClick={() => handleAction(selected.id, 'recover')}
                    className="flex-1 bg-[#0f172a] text-white rounded-full px-4 py-2 text-sm font-medium flex items-center justify-center gap-1.5 hover:bg-[#1e293b]"
                  >
                    <Check className="w-3.5 h-3.5" /> Mark recovered
                  </button>
                </div>
              )}

              {/* Spec 22a — Pause AI dropdown (any non-paused, non-handoff, non-terminal sub) */}
              {selected.status !== 'recovered' && selected.status !== 'lost' &&
                !(selected.founderHandoffAt && !selected.founderHandoffResolvedAt) &&
                !(selected.aiPausedUntil && new Date(selected.aiPausedUntil).getTime() > Date.now()) && (
                <div className="border-t border-slate-100 pt-3 mt-2">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                    Pause AI
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => handlePauseAction(selected.id, 'pause', 1, 'founder_handling')}
                      className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1 text-xs font-medium hover:bg-slate-50"
                    >
                      1 day
                    </button>
                    <button
                      onClick={() => handlePauseAction(selected.id, 'pause', 7, 'founder_handling')}
                      className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1 text-xs font-medium hover:bg-slate-50"
                    >
                      1 week
                    </button>
                    <button
                      onClick={() => handlePauseAction(selected.id, 'pause', 30, 'founder_handling')}
                      className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1 text-xs font-medium hover:bg-slate-50"
                    >
                      1 month
                    </button>
                    <button
                      onClick={() => handlePauseAction(selected.id, 'pause', null, 'founder_handling')}
                      className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1 text-xs font-medium hover:bg-slate-50"
                    >
                      Indefinite
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Changelog modal */}
      {changelogOpen && (
        <>
          <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setChangelogOpen(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-xl p-8 w-full max-w-lg">
              <h2 className="text-xl font-bold text-slate-900 mb-2">Update changelog</h2>
              <p className="text-sm text-slate-500 mb-4">What have you shipped recently? Winback uses this to write win-back emails that reference the exact things a cancelled subscriber asked for. Edit in place — add new lines on top, prune old ones as they become irrelevant.</p>
              <textarea
                value={changelogText}
                onChange={(e) => setChangelogText(e.target.value)}
                placeholder={`Examples:
- Team workspaces — share with up to 5 people, $5/seat (Apr)
- Fixed iOS share extension — images no longer drop
- Offline mode — notes sync when you reconnect

One line per shipment. Plain English. What customers would actually notice.`}
                className="min-h-[200px] w-full border border-slate-200 rounded-2xl p-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              {(() => {
                const n = changelogText.length
                const state: 'empty' | 'sparse' | 'good' | 'long' =
                  n === 0 ? 'empty'
                  : n < 200 ? 'sparse'
                  : n <= 2000 ? 'good'
                  : 'long'
                const hint = {
                  empty: '',
                  sparse: 'A bit sparse — a few more lines will help',
                  good: 'Looking good',
                  long: 'Consider trimming older entries',
                }[state]
                const hintColor = {
                  empty: 'text-slate-400',
                  sparse: 'text-slate-400',
                  good: 'text-green-600',
                  long: 'text-amber-600',
                }[state]
                return (
                  <div className="flex items-center justify-between mt-2 text-xs">
                    <span className={hintColor}>{hint}</span>
                    <span className="text-slate-400">{n.toLocaleString()} chars</span>
                  </div>
                )
              })()}
              <div className="flex justify-end gap-3 mt-4">
                <button
                  onClick={() => setChangelogOpen(false)}
                  className="border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={saveChangelog}
                  className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}

/**
 * Spec 40 — Payment-recovery table. Informational, no per-row drawer.
 * Click chevron → expand row in place to show email-touch history,
 * decline detail, and a single "Resend update-payment email" action.
 */
function PaymentRecoveryTable({
  rows,
  expandedRowId,
  onToggleExpand,
  onResendDunning,
}: {
  rows: Subscriber[]
  expandedRowId: string | null
  onToggleExpand: (id: string) => void
  onResendDunning: (id: string) => void
}) {
  if (rows.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-100 px-6 py-12 text-center text-sm text-slate-400">
        No payment recoveries yet. We&apos;ll show saves here as cards fail and we recover them.
      </div>
    )
  }
  return (
    <div className="bg-white rounded-2xl border border-slate-100 overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-slate-100">
            <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Subscriber</th>
            <th className="hidden sm:table-cell text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Failed at</th>
            <th className="hidden md:table-cell text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Decline</th>
            <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Stage</th>
            <th className="text-right text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">MRR</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {rows.map((sub) => {
            const expanded = expandedRowId === sub.id
            return (
              <Fragment key={sub.id}>
                <tr
                  onClick={() => onToggleExpand(sub.id)}
                  className="hover:bg-slate-50 cursor-pointer border-b border-slate-50 transition-colors"
                >
                  <td className="py-4 pr-4 px-4">
                    <div className="text-sm font-medium text-slate-900">{sub.name ?? 'Unknown'}</div>
                    <div className="text-xs text-slate-400 mt-0.5 truncate max-w-[160px] sm:max-w-none">{sub.email ?? ''}</div>
                  </td>
                  <td className="hidden sm:table-cell text-sm text-slate-600 py-4 px-4">
                    {sub.createdAt ? new Date(sub.createdAt).toISOString().split('T')[0] : '—'}
                  </td>
                  <td className="hidden md:table-cell text-sm text-slate-600 py-4 px-4">
                    {sub.lastDeclineCode ?? '—'}
                  </td>
                  <td className="py-4 px-4">
                    <DunningStageBadge sub={sub} />
                  </td>
                  <td className="text-sm font-medium text-slate-900 py-4 px-4 text-right">
                    ${(sub.mrrCents / 100).toFixed(2)}
                  </td>
                  <td className="text-slate-400 py-4 px-2 text-right">
                    <span className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>›</span>
                  </td>
                </tr>
                {expanded && (
                  <tr className="bg-slate-50/60 border-b border-slate-100">
                    <td colSpan={6} className="px-4 py-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Dunning state</div>
                          <div className="text-slate-700">{sub.dunningState ?? 'none'}</div>
                          {sub.dunningTouchCount != null && (
                            <div className="text-xs text-slate-500 mt-1">
                              T{sub.dunningTouchCount} sent
                              {sub.dunningLastTouchAt
                                ? ` on ${new Date(sub.dunningLastTouchAt).toISOString().split('T')[0]}`
                                : ''}
                            </div>
                          )}
                          {sub.nextPaymentAttemptAt && (
                            <div className="text-xs text-slate-500 mt-1">
                              Next Stripe retry: {new Date(sub.nextPaymentAttemptAt).toISOString().split('T')[0]}
                            </div>
                          )}
                        </div>
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Last decline</div>
                          <div className="text-slate-700">{sub.lastDeclineCode ?? '—'}</div>
                        </div>
                      </div>
                      {(sub.dunningState === 'awaiting_retry' || sub.dunningState === 'final_retry_pending') && (
                        <div className="mt-4">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              onResendDunning(sub.id)
                            }}
                            className="bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium hover:bg-[#1e293b]"
                          >
                            Resend update-payment email
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Spec 40 — short stage label for payment-recovery rows. Reads the
 * dunning-state column directly so the badge is always in sync with
 * the state machine the cron uses.
 */
function DunningStageBadge({ sub }: { sub: Subscriber }) {
  const state = sub.dunningState
  if (sub.status === 'recovered') {
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200">Recovered</span>
  }
  if (state === 'final_retry_pending') {
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">Final retry</span>
  }
  if (state === 'awaiting_retry') {
    const t = sub.dunningTouchCount ?? 1
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">In retry · T{t}</span>
  }
  if (state === 'churned_during_dunning') {
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">Lost</span>
  }
  return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">{state ?? '—'}</span>
}

/**
 * Spec 40 polish — First-recovery banner. Slides in from the top and
 * fires a confetti burst once on mount. CSS-only animation; no deps.
 */
function FirstRecoveryBanner({
  firstRecovery,
  onDismiss,
}: {
  firstRecovery: { name: string | null; mrrCents: number }
  onDismiss: () => void
}) {
  return (
    <div
      className="relative overflow-hidden bg-white border border-blue-100 rounded-2xl p-5 mb-6 flex items-start justify-between gap-4"
      style={{ animation: 'wb-slide-in 420ms cubic-bezier(0.2, 0.9, 0.32, 1.12) both' }}
    >
      {/* Confetti burst — 12 particles in a half-arc, CSS keyframes only */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {Array.from({ length: 12 }).map((_, i) => {
          const colors = ['#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4']
          const c = colors[i % colors.length]
          const angle = (i / 12) * Math.PI - Math.PI / 2 // -90..+90
          const dx = Math.cos(angle) * 80
          const dy = Math.sin(angle) * 60 - 30
          return (
            <span
              key={i}
              className="absolute left-12 top-9 block w-1.5 h-1.5 rounded-sm"
              style={{
                background: c,
                animation: `wb-confetti 900ms ease-out both`,
                animationDelay: `${50 + i * 18}ms`,
                ['--dx' as string]: `${dx}px`,
                ['--dy' as string]: `${dy}px`,
              } as React.CSSProperties}
            />
          )
        })}
      </div>

      <style>{`
        @keyframes wb-slide-in {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes wb-confetti {
          from { opacity: 1; transform: translate(0, 0) rotate(0deg); }
          to   { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(220deg); }
        }
      `}</style>

      <div className="flex items-start gap-4 relative z-10">
        <div className="bg-blue-50 rounded-full p-2 flex-shrink-0">
          <Sparkles className="w-4 h-4 text-blue-600" />
        </div>
        <div>
          <p className="text-sm font-medium text-slate-900">
            🎉 Your first recovery is in{firstRecovery.name ? ` — ${firstRecovery.name} is back` : ''} at ${(firstRecovery.mrrCents / 100).toFixed(0)}/mo.
          </p>
          <p className="text-sm text-slate-600 mt-1">
            Add a payment method to start your $99/mo subscription —
            covers up to 500 payment recoveries/month, plus a one-time
            fee of <strong>1× MRR</strong> per win-back (refundable for
            14 days).
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3 sm:gap-4">
            <a href="/settings#billing" className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]">
              Add billing to keep recovering
            </a>
            <button onClick={onDismiss} className="text-sm text-slate-400 hover:text-slate-600">Not now</button>
          </div>
        </div>
      </div>
      <button onClick={onDismiss} className="text-slate-400 hover:text-slate-600 relative z-10">
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

/**
 * Spec 40 — Pattern pills. Read-only chips showing a category breakdown
 * (top cancellation reasons / top decline codes). Each category gets a
 * stable semantic color so the founder can scan the strip and read
 * meaning at a glance.
 *
 * Color rationale:
 *   Win-back reasons:
 *     Price    → rose   (revenue threat — frequent, fixable with bundling/discount)
 *     Feature  → blue   (product gap — actionable signal for the roadmap)
 *     Quality  → amber  (operational warning — bugs/deliverability/perf)
 *     Switched → violet (competitive intel — who beat us, why)
 *     Unused   → slate  (low recoverability — passive churn)
 *     Other    → slate  (catch-all)
 *   Decline codes (Stripe semantics):
 *     insufficient_funds → amber  (temporary; often self-resolves at next pay cycle)
 *     expired_card       → blue   (one click to fix once the customer updates)
 *     do_not_honor       → rose   (bank refused; lower recoverability)
 *     generic_decline    → slate  (unknown bucket)
 */
const PATTERN_COLOR_MAP: Record<string, string> = {
  // win-back categories
  Price:    'bg-rose-50 text-rose-700',
  Feature:  'bg-blue-50 text-blue-700',
  Quality:  'bg-amber-50 text-amber-700',
  Switched: 'bg-violet-50 text-violet-700',
  Unused:   'bg-slate-100 text-slate-600',
  Other:    'bg-slate-100 text-slate-600',
  // decline codes
  insufficient_funds: 'bg-amber-50 text-amber-700',
  expired_card:       'bg-blue-50 text-blue-700',
  do_not_honor:       'bg-rose-50 text-rose-700',
  generic_decline:    'bg-slate-100 text-slate-600',
}
const PATTERN_DEFAULT = 'bg-slate-100 text-slate-700'

function PatternPills({ items }: { items: Array<{ label: string; pct: number }> }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      {items.map((r) => {
        const color = PATTERN_COLOR_MAP[r.label] ?? PATTERN_DEFAULT
        return (
          <span
            key={r.label}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${color}`}
          >
            <span>{r.label}</span>
            <span className="opacity-60 tabular-nums">{r.pct}%</span>
          </span>
        )
      })}
    </div>
  )
}

/**
 * Spec 39 — Single stat card. Mirrors the original dashboard card style
 * (icon top-left, big number, small label). Used in both the win-back
 * row and the payment-recovery row.
 */
function StatCard({
  accent,
  icon,
  value,
  label,
  delta,
  sparkline,
  subValue,
}: {
  accent: 'blue' | 'green' | 'amber'
  icon: React.ReactNode
  value: string
  label: string
  /** Spec 40 polish — month-over-month change. Pass a string like '+3' / '-$120' / '—'. */
  delta?: { text: string; direction: 'up' | 'down' | 'flat' }
  /** Spec 40 polish — 30-day daily series for the sparkline. */
  sparkline?: number[]
  /** Spec 41 — small line under the big value (e.g. "$480/mo currently active"). */
  subValue?: string
}) {
  const accentClass =
    accent === 'blue'
      ? 'bg-blue-50 text-blue-600'
      : accent === 'green'
      ? 'bg-green-50 text-green-600'
      : 'bg-amber-50 text-amber-600'

  const deltaClass =
    delta?.direction === 'up'
      ? 'text-emerald-600'
      : delta?.direction === 'down'
      ? 'text-rose-600'
      : 'text-slate-400'

  return (
    <div className="bg-white rounded-2xl border border-slate-100 px-4 py-4">
      <div className="flex items-start justify-between">
        <div className={`${accentClass} rounded-lg w-7 h-7 flex items-center justify-center`}>
          {icon}
        </div>
        {sparkline && sparkline.length > 0 && (
          <Sparkline data={sparkline} accent={accent} />
        )}
      </div>
      <div className="text-2xl sm:text-3xl font-bold text-slate-900 mt-2.5 tabular-nums">{value}</div>
      {subValue && (
        <div className="text-xs text-slate-500 tabular-nums mt-0.5">{subValue}</div>
      )}
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-0.5">
        {label}
      </div>
      {delta && (
        <div className={`text-[11px] font-medium tabular-nums mt-1.5 ${deltaClass}`}>
          {delta.text}
          <span className="text-slate-400 font-normal"> vs last month</span>
        </div>
      )}
    </div>
  )
}

/**
 * Spec 40 polish — Sparkline. Tiny SVG line chart for a daily series
 * (typically last 30 days). Renders inline at the top-right of a
 * StatCard so it provides at-a-glance trend without competing with the
 * primary number below.
 *
 * Visually quiet by design: stroke-only line, no axes, no fills, no
 * dots. Width/height are fixed; the path is normalised to the data's
 * min/max so even a small range stays visible.
 */
function Sparkline({ data, accent }: { data: number[]; accent: 'blue' | 'green' | 'amber' }) {
  const w = 64
  const h = 22
  if (data.length === 0) return null
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const dx = w / Math.max(data.length - 1, 1)
  const points = data
    .map((v, i) => `${(i * dx).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(' ')
  const stroke =
    accent === 'blue' ? '#2563eb' : accent === 'green' ? '#16a34a' : '#d97706'
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden className="text-slate-300">
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
      />
    </svg>
  )
}

/**
 * Spec 40 polish — Format an integer or money delta for the StatCard.
 * Returns a `{text, direction}` payload the card knows how to render.
 */
function formatDelta(curr: number, prev: number, kind: 'count' | 'money'): { text: string; direction: 'up' | 'down' | 'flat' } {
  const diff = curr - prev
  if (diff === 0) return { text: '—', direction: 'flat' }
  const sign = diff > 0 ? '+' : '−'
  const abs = Math.abs(diff)
  const value = kind === 'money' ? `$${Math.round(abs / 100).toLocaleString()}` : `${abs}`
  return { text: `${sign}${value}`, direction: diff > 0 ? 'up' : 'down' }
}

'use client'

import { useState, useEffect, useCallback, Fragment } from 'react'
import Link from 'next/link'
import { StatusBadge } from '@/components/status-badge'
import { AiStateBadge } from '@/components/ai-state-badge'
import { TrendingUp, CheckCircle, DollarSign, Users, Search, Zap, X, RotateCcw, Check, Loader2, Sparkles, MessageSquare, CreditCard, ChevronRight, ChevronDown, Copy, Mail } from 'lucide-react'

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
// Spec 43 — pipeline strip per cohort.
interface Pipeline30d {
  churnedMrrCents: number
  recoveredMrrCents: number
  inFlightMrrCents: number
  lostMrrCents: number
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
    pipeline30d: Pipeline30d
  }
  paymentRecovery: {
    thisMonth: Bucket
    lastMonth: Bucket
    allTime: Bucket & { recoveryRate: number | null }
    inDunning: number
    topDeclineCodes: LabelPct[]
    filterCounts: PaymentFilterCounts
    dailyRecovered: number[]
    pipeline30d: Pipeline30d
  }
}

const EMPTY_BUCKET: Bucket = { recovered: 0, mrrRecoveredCents: 0 }
const EMPTY_PIPELINE: Pipeline30d = {
  churnedMrrCents: 0,
  recoveredMrrCents: 0,
  inFlightMrrCents: 0,
  lostMrrCents: 0,
}
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
    pipeline30d: EMPTY_PIPELINE,
  },
  paymentRecovery: {
    thisMonth: EMPTY_BUCKET,
    lastMonth: EMPTY_BUCKET,
    allTime: { recovered: 0, mrrRecoveredCents: 0, recoveryRate: null },
    inDunning: 0,
    topDeclineCodes: [],
    filterCounts: { all: 0, 'in-retry': 0, 'final-retry': 0, recovered: 0, lost: 0 },
    dailyRecovered: [],
    pipeline30d: EMPTY_PIPELINE,
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
  isTrial: boolean
  firstRecovery: { name: string | null; mrrCents: number } | null
  /** Spec 31 — ISO string of pilot_until if the customer is currently on
   *  pilot, null otherwise. Drives the pilot banner that replaces the
   *  generic "billing inactive" prompt. */
  pilotUntilIso?: string | null
  /** Spec 50 — used as the signature in the pre-filled body of the
   *  external-contact compose helper. Falls back to "The team". */
  founderName?: string | null
  /** Spec 51 — count of recoverable subscribers (high/medium likelihood,
   *  not yet recovered) for the ROI-framed banner. Spec 53 extends to
   *  include in-flight payment-recovery rows too — total across both
   *  cohorts. */
  atRiskCount?: number
  /** Spec 51 + 53 — sum of mrr_cents × 12 across at-risk rows in BOTH
   *  cohorts. */
  atRiskMrrAnnualizedCents?: number
  /** Spec 53 — at-risk cohort breakdown for the banner copy. */
  atRiskCancellationsCount?: number
  /** Spec 53 — at-risk cohort breakdown for the banner copy. */
  atRiskPaymentRecoveriesCount?: number
  /** Spec 51 — ISO of customer.activated_at; non-null means first
   *  recovery delivered. Drives the persistent paused-state UI. */
  activatedAtIso?: string | null
  /** Whether this customer has ever had a platform subscription that
   *  was later canceled. When true, the paused-state banner reads
   *  "Your subscription ended" instead of "Your trial ended on your
   *  first recovery" — the same paused state, but different cause
   *  and so different copy. */
  everSubscribed?: boolean
  /** Spec 55 — Settings → "Pause win-back" toggle. When set, no
   *  voluntary-cancel emails (exit / reply / reengagement nudge)
   *  go out. Dashboard renders an amber banner reflecting the
   *  paused cohort(s). */
  manuallyPausedWinbackAtIso?: string | null
  /** Spec 55 — Settings → "Pause payment-recovery" toggle. When set,
   *  no dunning / dunning-followup emails go out. Independent of
   *  the win-back pause — both can be active. */
  manuallyPausedDunningAtIso?: string | null
}

export function DashboardClient({
  isTrial,
  firstRecovery,
  pilotUntilIso = null,
  founderName = null,
  atRiskCount = 0,
  atRiskMrrAnnualizedCents = 0,
  atRiskCancellationsCount = 0,
  atRiskPaymentRecoveriesCount = 0,
  activatedAtIso = null,
  everSubscribed = false,
  manuallyPausedWinbackAtIso = null,
  manuallyPausedDunningAtIso = null,
}: DashboardClientProps) {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)
  // Spec 52 — `null` means "first fetch hasn't completed yet"; `[]` means
  // "loaded and empty". Lets the table avoid flashing the "No win-backs yet"
  // empty state during initial mount (most visible when navigating back from
  // /billing/success after Subscribe completes).
  const [subscribers, setSubscribers] = useState<Subscriber[] | null>(null)
  const [statsLoaded, setStatsLoaded] = useState(false)
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
  // Spec 50 — collapsible "email them yourself" section in the suppressed
  // subscriber drawer. State is keyed nowhere because we only show the
  // section for one subscriber at a time (the selected one).
  const [externalContactOpen, setExternalContactOpen] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  useEffect(() => {
    // Reset on subscriber change so a new drawer always starts collapsed.
    setExternalContactOpen(false)
  }, [selected?.id])
  // Spec 51 — bannerDismissed removed. Banner visibility is now derived
  // purely from server state (activatedAt + stripeSubscriptionId). No more
  // localStorage-driven indefinite dismissal.
  const [backfill, setBackfill] = useState<BackfillStatus | null>(null)
  const [backfillBannerDismissed, setBackfillBannerDismissed] = useState(false)

  useEffect(() => {
    // Spec 51 — winback_banner_dismissed key removed. Clean up any stale
    // value left over from before the rewrite so it doesn't linger.
    if (localStorage.getItem('winback_banner_dismissed')) {
      localStorage.removeItem('winback_banner_dismissed')
    }
    const bfDismissed = localStorage.getItem('winback_backfill_dismissed')
    if (bfDismissed) setBackfillBannerDismissed(true)
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
    // Defensive: if the server returns 401/404/500 (e.g. session expired
    // mid-flow, customer lookup race after subscribe), the body may be
    // `{ error: '...' }` not the expected shape. Without guards, calling
    // setStats / setSubscribers with the error object causes downstream
    // .map() / .length reads to throw, and the table goes blank with no
    // explanation. Log + fall back to empty-but-loaded state so the UI
    // is at least honest about the failure.
    fetch('/api/stats')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (data && typeof data === 'object' && 'winBack' in data) {
          setStats(data)
        } else {
          console.warn('[dashboard] /api/stats returned unexpected shape:', data)
        }
        setStatsLoaded(true)
      })
      .catch((err) => {
        console.error('[dashboard] /api/stats fetch failed:', err)
        setStatsLoaded(true) // unblock UI so KPIs show "—" rather than spinning
      })
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
    fetch(`/api/subscribers?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (Array.isArray(data)) {
          setSubscribers(data)
        } else {
          console.warn('[dashboard] /api/subscribers returned non-array:', data)
          setSubscribers([])
        }
      })
      .catch((err) => {
        console.error('[dashboard] /api/subscribers fetch failed:', err)
        setSubscribers([]) // show "No win-backs yet" rather than blank loading state
      })
  }, [tab, filter, search])

  useEffect(() => { fetchData() }, [fetchData])

  // Spec 40 — switching tabs closes any open per-row UI on the previous tab:
  // collapse expanded payment-recovery row, close the win-back drawer.
  useEffect(() => {
    setExpandedRowId(null)
    setSelected(null)
  }, [tab])

  // Spec 51 — dismissBanner removed. Banner is server-derived; no
  // localStorage dismissal. Merchant subscribes or stays paused.

  async function handleAction(id: string, action: 'resend' | 'recover') {
    await fetch(`/api/subscribers/${id}/${action}`, { method: 'POST' })
    setSelected(null)
    fetchData()
  }

  // Spec 50 — register an external contact (merchant emailed from their
  // own client). Inserts a stub emails_sent row + flips lost → contacted.
  async function handleExternalContact(id: string) {
    await fetch(`/api/subscribers/${id}/external-contact`, { method: 'POST' })
    setSelected(null)
    fetchData()
  }

  // Spec 50 — fire-and-forget version: mark + open the compose URL in
  // a new tab. Used by the Gmail/Outlook/mailto launch buttons.
  function fireAndOpen(id: string, composeUrl: string) {
    fetch(`/api/subscribers/${id}/external-contact`, { method: 'POST' }).catch(() => {})
    window.open(composeUrl, '_blank', 'noopener,noreferrer')
    setSelected(null)
    fetchData()
  }

  // Spec 51 — Subscribe button on the banner. Opens Stripe Checkout
  // directly (setup-intent flow). Used by both the main banner and the
  // persistent paused status bar. Failures bubble up to a small inline
  // error message on the banner.
  const [subscribeError, setSubscribeError] = useState<string | null>(null)
  const [subscribing, setSubscribing] = useState(false)
  async function handleSubscribe() {
    setSubscribeError(null)
    setSubscribing(true)
    try {
      const res = await fetch('/api/billing/setup-intent', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `Failed (${res.status})`)
      }
      const { url } = await res.json()
      if (!url) throw new Error('No checkout URL returned')
      window.location.href = url
    } catch (e) {
      setSubscribeError(e instanceof Error ? e.message : String(e))
      setSubscribing(false)
    }
  }

  // Spec 50 — clipboard copy with brief "Copied!" feedback.
  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyFeedback(label)
      setTimeout(() => setCopyFeedback(null), 2000)
    } catch {
      // No-op if clipboard API blocked. Merchant can always select+copy manually.
    }
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
  // Spec 51 — banner shows whenever the customer is in post-trial paused
  // state: first recovery delivered (activatedAt set) AND no subscription
  // AND not on pilot. Server-derived; no localStorage dismissal.
  const isPaused = !onPilot && isTrial && !!activatedAtIso
  const showBanner = isPaused && !!firstRecovery

  // Spec 55 — Settings-paused state. Independent of the billing-paused
  // state (spec 51/53) — both can render simultaneously.
  const winbackPaused = !!manuallyPausedWinbackAtIso
  const dunningPaused = !!manuallyPausedDunningAtIso
  const anyManuallyPaused = winbackPaused || dunningPaused
  const manualPauseCopy = (() => {
    if (winbackPaused && dunningPaused) {
      return 'All Winback emails are paused in Settings (win-back AND payment recovery). New cancellations and failed payments still land here — nothing goes out until you resume.'
    }
    if (winbackPaused) {
      return 'Win-back emails are paused in Settings. New cancellations are still recorded — but no win-back emails go out until you resume.'
    }
    return 'Payment-recovery emails are paused in Settings. New failed payments are still recorded — but no dunning emails go out until you resume.'
  })()

  return (
    <>
      {/* Spec 55 — manual pause banner. Renders first because it's the
          more immediately reversible (one toggle in Settings) vs the
          billing-paused banner below (requires a Stripe subscription). */}
      {anyManuallyPaused && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl px-5 py-4 mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 text-sm text-amber-900">
            <span className="text-base leading-none mt-0.5">⏸</span>
            <span>
              <strong className="font-semibold">You paused sending in Settings.</strong>{' '}
              {manualPauseCopy}
            </span>
          </div>
          <Link
            href="/settings"
            className="flex-shrink-0 text-sm font-medium text-amber-900 underline hover:text-amber-700"
          >
            Resume in Settings →
          </Link>
        </div>
      )}

      {/* Spec 51 — persistent paused status bar. Shows whenever the customer
          is in post-trial paused state and the main ROI banner isn't visible
          (the main banner is more prominent and already communicates state). */}
      {isPaused && !showBanner && (
        <div className="bg-amber-100 border border-amber-300 rounded-2xl px-5 py-3 mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-sm text-amber-900">
            <span className="text-base leading-none">⏸</span>
            <span>
              <strong className="font-semibold">Winback is paused</strong>{' '}
              — recoveries won't send until you subscribe.
            </span>
          </div>
          <button
            onClick={handleSubscribe}
            disabled={subscribing}
            className="bg-amber-900 text-amber-50 rounded-full px-4 py-1.5 text-xs font-medium hover:bg-amber-800 flex-shrink-0 disabled:opacity-60"
          >
            {subscribing ? 'Opening Stripe…' : 'Subscribe to resume →'}
          </button>
        </div>
      )}

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4 mb-6">
        <div>
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">Overview</div>
          <h1 className="text-4xl font-bold text-slate-900">Dashboard.</h1>
          <p className="text-sm text-slate-500 mt-1">Every cancellation, every recovery — all in one view.</p>
        </div>
        <a
          href="/reasons"
          className="self-start border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium flex-shrink-0 inline-block"
        >
          Manage Winback reasons
        </a>
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

      {/* Spec 51 — ROI-framed billing banner. Server-rendered visibility
          (no localStorage dismissal). Shows whenever the customer is in
          the post-trial paused state. */}
      {showBanner && (
        <FirstRecoveryBanner
          firstRecovery={firstRecovery!}
          atRiskCount={atRiskCount}
          atRiskMrrAnnualizedCents={atRiskMrrAnnualizedCents}
          atRiskCancellationsCount={atRiskCancellationsCount}
          atRiskPaymentRecoveriesCount={atRiskPaymentRecoveriesCount}
          everSubscribed={everSubscribed}
          onSubscribe={handleSubscribe}
          subscribing={subscribing}
          error={subscribeError}
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
                  Importing your cancellation history…
                </p>
                {/*
                  Spec 72 — we no longer pre-count the total before pagination
                  finishes, so the progress denominator is unknown until the
                  backfill is complete. Show the running count of rows pulled
                  so far instead of a percentage bar.
                */}
                <p className="text-sm text-slate-500 mt-1">
                  {backfill.processed} subscriber{backfill.processed === 1 ? '' : 's'} imported so far.
                  The rest will appear over the next few minutes — feel free to come back later.
                </p>
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
                    We found {backfill.processed} cancelled subscriber{backfill.processed !== 1 ? 's' : ''} — £{Math.round(backfill.lostMrrCents / 100).toLocaleString()}/mo in lost revenue.
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

      {/* Spec 40/43 — Win-back tab. Reading order top→bottom:
          handoff alert (act now) → pipeline strip (loss framing) →
          KPI band → pattern strip → subscriber table. */}
      {tab === 'winback' && (
        <>
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
          <PipelineStrip pipeline={stats.winBack.pipeline30d} />
          {/* KPI row — blue tint background */}
          <section className="rounded-3xl bg-blue-100 border border-blue-200 p-3 mb-7">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              <StatCard
                loading={!statsLoaded}
                accent="blue"
                icon={<TrendingUp className="w-4 h-4" />}
                value={stats.winBack.allTime.recoveryRate === null ? '—' : `${stats.winBack.allTime.recoveryRate}%`}
                label="Recovery rate (30d)"
              />
              <StatCard
                loading={!statsLoaded}
                accent="blue"
                icon={<CheckCircle className="w-4 h-4" />}
                value={String(stats.winBack.allTime.recovered)}
                label="Recovered · lifetime"
                delta={formatDelta(
                  stats.winBack.thisMonth.recovered,
                  stats.winBack.lastMonth.recovered,
                  'count',
                )}
                sparkline={stats.winBack.dailyRecovered}
              />
              <StatCard
                loading={!statsLoaded}
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
                loading={!statsLoaded}
                accent="amber"
                icon={<Users className="w-4 h-4" />}
                value={String(stats.winBack.inProgress)}
                label="In progress"
              />
            </div>
          </section>
          {stats.winBack.topReasons.length > 0 && (
            <PatternPills items={stats.winBack.topReasons} />
          )}
        </>
      )}

      {/* Spec 40/43 — Payment-recovery tab. No handoff alert (win-back only).
          Reading order: pipeline strip → KPI band → pattern strip → table. */}
      {tab === 'paymentRecovery' && (
        <>
          <PipelineStrip pipeline={stats.paymentRecovery.pipeline30d} />
          {/* KPI row — green tint background */}
          <section className="rounded-3xl bg-green-100 border border-green-200 p-3 mb-7">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              <StatCard
                loading={!statsLoaded}
                accent="green"
                icon={<TrendingUp className="w-4 h-4" />}
                value={stats.paymentRecovery.allTime.recoveryRate === null ? '—' : `${stats.paymentRecovery.allTime.recoveryRate}%`}
                label="Recovery rate (30d)"
              />
              <StatCard
                loading={!statsLoaded}
                accent="green"
                icon={<CheckCircle className="w-4 h-4" />}
                value={String(stats.paymentRecovery.allTime.recovered)}
                label="Recovered · lifetime"
                delta={formatDelta(
                  stats.paymentRecovery.thisMonth.recovered,
                  stats.paymentRecovery.lastMonth.recovered,
                  'count',
                )}
                sparkline={stats.paymentRecovery.dailyRecovered}
              />
              <StatCard
                loading={!statsLoaded}
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
                loading={!statsLoaded}
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
              {(subscribers ?? []).map((sub) => (
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
                    <AiStateBadge sub={sub} compact billingPaused={isPaused} />
                  </td>
                  <td className="text-sm font-medium text-slate-900 py-4 px-4 text-right">
                    ${(sub.mrrCents / 100).toFixed(2)}
                  </td>
                </tr>
              ))}
              {subscribers !== null && subscribers.length === 0 && (
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
          billingPaused={isPaused}
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
                      We&apos;ll auto-fire a win-back when you ship a matching improvement on the{' '}
                      <a href="/reasons" className="underline">Winback reasons</a> page.
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

              {/* Spec 50 — collapsible "email them yourself" helper for suppressed subs.
                  AI's suppression is final from our side; this lets the merchant pick up
                  the conversation in their own inbox using the signed reactivate URL. */}
              {selected.status === 'lost' && selected.email && !selected.doNotContact && (() => {
                const appUrl =
                  (typeof window !== 'undefined' ? window.location.origin : '') ||
                  process.env.NEXT_PUBLIC_APP_URL || 'https://winbackflow.co'
                const reactivateUrl = `${appUrl}/api/reactivate/${selected.id}`
                const firstName = selected.name?.split(' ')[0] ?? 'there'
                const fromName = founderName ?? 'The team'
                const subject = `Following up on your cancellation`
                const body =
                  `Hi ${firstName},\n\n` +
                  `Saw you cancelled — wanted to reach out personally.\n\n` +
                  `[your message here]\n\n` +
                  `When you're ready, here's a one-click link to restart:\n` +
                  `→ ${reactivateUrl}\n\n` +
                  `– ${fromName}`
                const enc = encodeURIComponent
                const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${enc(selected.email)}&su=${enc(subject)}&body=${enc(body)}`
                const outlookUrl = `https://outlook.live.com/mail/0/deeplink/compose?to=${enc(selected.email)}&subject=${enc(subject)}&body=${enc(body)}`
                const mailtoUrl = `mailto:${enc(selected.email)}?subject=${enc(subject)}&body=${enc(body)}`

                return (
                  <div className="border-t border-slate-100 pt-3">
                    <button
                      onClick={() => setExternalContactOpen((v) => !v)}
                      className="w-full flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 hover:text-slate-700"
                    >
                      {externalContactOpen ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                      Email them yourself
                    </button>

                    {externalContactOpen && (
                      <div className="mt-3 space-y-3">
                        <p className="text-xs text-slate-500 leading-relaxed">
                          Have context the AI didn&apos;t? Email from your own inbox.
                        </p>

                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                            To
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-slate-700 truncate flex-1">{selected.email}</span>
                            <button
                              onClick={() => copyToClipboard(selected.email!, 'email')}
                              className="border border-slate-200 bg-white text-slate-600 rounded-full px-2.5 py-0.5 text-xs font-medium hover:bg-slate-50 inline-flex items-center gap-1"
                            >
                              <Copy className="w-3 h-3" />
                              {copyFeedback === 'email' ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                        </div>

                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">
                            Reactivate link
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-600 truncate flex-1 font-mono">{reactivateUrl}</span>
                            <button
                              onClick={() => copyToClipboard(reactivateUrl, 'link')}
                              className="border border-slate-200 bg-white text-slate-600 rounded-full px-2.5 py-0.5 text-xs font-medium hover:bg-slate-50 inline-flex items-center gap-1"
                            >
                              <Copy className="w-3 h-3" />
                              {copyFeedback === 'link' ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                            Including this link lets us credit the recovery if they come back.
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => fireAndOpen(selected.id, gmailUrl)}
                            className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1.5 text-xs font-medium hover:bg-slate-50 inline-flex items-center gap-1.5"
                          >
                            <Mail className="w-3 h-3" /> Open in Gmail
                          </button>
                          <button
                            onClick={() => fireAndOpen(selected.id, outlookUrl)}
                            className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1.5 text-xs font-medium hover:bg-slate-50 inline-flex items-center gap-1.5"
                          >
                            <Mail className="w-3 h-3" /> Open in Outlook
                          </button>
                          <button
                            onClick={() => fireAndOpen(selected.id, mailtoUrl)}
                            className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1.5 text-xs font-medium hover:bg-slate-50 inline-flex items-center gap-1.5"
                          >
                            <Mail className="w-3 h-3" /> Open in mail app
                          </button>
                        </div>

                        <div className="pt-2 border-t border-slate-100">
                          <p className="text-xs text-slate-500 mb-2">Used a different tool?</p>
                          <button
                            onClick={() => handleExternalContact(selected.id)}
                            className="border border-slate-200 bg-white text-slate-700 rounded-full px-3 py-1.5 text-xs font-medium hover:bg-slate-50 inline-flex items-center gap-1.5"
                          >
                            <Check className="w-3 h-3" /> Mark as contacted
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}

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
  billingPaused = false,
}: {
  // null = first fetch not yet completed; [] = loaded and empty.
  rows: Subscriber[] | null
  expandedRowId: string | null
  onToggleExpand: (id: string) => void
  onResendDunning: (id: string) => void
  /** Spec 53 — when true, in-flight dunning rows render as "⏸ Trial ended" */
  billingPaused?: boolean
}) {
  // Spec 52 — don't render the empty state until we know the table is
  // genuinely empty (not just mid-fetch). Avoids the brief flash of
  // "No payment recoveries yet" on initial mount, which is now reachable
  // every time a merchant clicks "Back to dashboard" from /billing/success.
  if (rows === null) {
    return <div className="bg-white rounded-2xl border border-slate-100 px-6 py-12" aria-hidden />
  }
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
                    <DunningStageBadge sub={sub} billingPaused={billingPaused} />
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
function DunningStageBadge({ sub, billingPaused = false }: { sub: Subscriber; billingPaused?: boolean }) {
  const state = sub.dunningState
  if (sub.status === 'recovered') {
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200">Recovered</span>
  }
  // Spec 53 — when billing-paused, in-flight dunning rows show "Trial
  // ended" instead of "In retry · Tn" / "Final retry". Terminal states
  // (recovered handled above, churned_during_dunning below) keep their
  // normal badges.
  if (billingPaused && (state === 'awaiting_retry' || state === 'final_retry_pending')) {
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">⏸ Trial ended</span>
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
  atRiskCount,
  atRiskMrrAnnualizedCents,
  atRiskCancellationsCount,
  atRiskPaymentRecoveriesCount,
  everSubscribed,
  onSubscribe,
  subscribing,
  error,
}: {
  firstRecovery: { name: string | null; mrrCents: number }
  atRiskCount: number
  atRiskMrrAnnualizedCents: number
  atRiskCancellationsCount: number
  atRiskPaymentRecoveriesCount: number
  everSubscribed: boolean
  onSubscribe: () => void
  subscribing: boolean
  error: string | null
}) {
  // Spec 53 — Trial-ended causal-story banner. Drops the ROI framing
  // (which broke for $0-mrr first recoveries) and replaces with a single
  // clear narrative: trial ended on first recovery → AI paused →
  // subscribe to resume. Inner celebration strip is conditional on the
  // first recovery having actual revenue.
  //
  // Follow-up to spec 54 — branch the copy for re-pausers (customers who
  // had a subscription, cancelled it, and the cycle expired). They're in
  // the same paused state as a first-time pauser, but reading "Your trial
  // ended" is wrong for someone who was paying. Detected via the
  // platform_subscription_canceled event in wb_events.
  const showCelebration = !everSubscribed && firstRecovery.mrrCents > 0
  const recoveredName = firstRecovery.name ?? 'Your first subscriber'
  const recoveredMrrUsd = (firstRecovery.mrrCents / 100).toFixed(0)
  const atRiskAnnualUsd = Math.round(atRiskMrrAnnualizedCents / 100).toLocaleString()

  const headline = everSubscribed
    ? 'Your subscription ended.'
    : 'Your trial ended on your first recovery.'
  const subhead = everSubscribed
    ? 'The AI has paused new sends until you re-subscribe.'
    : 'The AI has paused new sends until you subscribe.'
  const ctaLabel = everSubscribed ? 'Re-subscribe via Stripe' : 'Subscribe via Stripe'

  // Cohort breakdown line — only render if we actually have a split to show.
  const cohortParts: string[] = []
  if (atRiskCancellationsCount > 0) {
    cohortParts.push(`${atRiskCancellationsCount} cancellation${atRiskCancellationsCount === 1 ? '' : 's'}`)
  }
  if (atRiskPaymentRecoveriesCount > 0) {
    cohortParts.push(`${atRiskPaymentRecoveriesCount} failed payment${atRiskPaymentRecoveriesCount === 1 ? '' : 's'}`)
  }
  const cohortBreakdown = cohortParts.length > 0 ? ` (${cohortParts.join(' + ')})` : ''

  // "N more subscribers" vs "N subscribers" — "more" only fires when
  // there's a headline recovery being broken out in the celebration strip.
  const atRiskNoun = showCelebration ? 'more subscribers' : 'subscribers'

  return (
    <div
      className="relative overflow-hidden bg-gradient-to-br from-blue-50 via-white to-emerald-50 border-2 border-red-400 rounded-2xl p-7 mb-6 shadow-sm"
      style={{ animation: 'wb-slide-in 420ms cubic-bezier(0.2, 0.9, 0.32, 1.12) both' }}
    >
      {/* Subtle decorative glows */}
      <div aria-hidden className="pointer-events-none">
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-blue-200/30 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-16 -left-16 w-40 h-40 bg-emerald-200/30 rounded-full blur-3xl"></div>
      </div>

      <style>{`
        @keyframes wb-slide-in {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className="relative">
        <div className="flex items-start gap-3 mb-4">
          <span className="text-2xl leading-none flex-shrink-0">⏸</span>
          <div>
            <h2 className="text-xl font-bold text-slate-900 leading-tight">
              {headline}
            </h2>
            <p className="text-sm text-slate-600 mt-1">
              {subhead}
            </p>
          </div>
        </div>

        {showCelebration && (
          <div className="bg-white/70 rounded-xl px-4 py-3 mb-4 border border-emerald-200 inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200">
              ✓ First recovery
            </span>
            <span className="text-sm text-slate-700">
              <span className="font-semibold text-slate-900">{recoveredName}</span> · <span className="font-semibold text-emerald-700">${recoveredMrrUsd}/mo</span> restored
            </span>
          </div>
        )}

        {atRiskCount > 0 && (
          <p className="text-sm text-slate-700 leading-relaxed mb-5">
            <strong className="text-red-700">${atRiskAnnualUsd}/yr</strong> at risk across{' '}
            <strong className="text-slate-900">{atRiskCount} {atRiskNoun}</strong> in your queue{cohortBreakdown}.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-4">
          <button
            onClick={onSubscribe}
            disabled={subscribing}
            className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-semibold hover:bg-[#1e293b] inline-flex items-center gap-2 shadow-md disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {subscribing ? 'Opening Stripe…' : ctaLabel}
            {!subscribing && <span>→</span>}
          </button>
          <span className="text-xs text-slate-500">
            $99/mo + 1× MRR per recovery · Refundable for 14 days if they re-cancel
          </span>
        </div>
        {error && (
          <p className="text-xs text-red-600 mt-3">
            Couldn&apos;t open Stripe Checkout: {error}. Try again, or contact support if it persists.
          </p>
        )}
      </div>
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
 * Spec 43 — Loss-framing pipeline strip. Sits above the KPI band on
 * each tab. Tells the merchant "of $X churned in the last 30 days,
 * here's the recovered/in-flight/lost breakdown" — same numbers as
 * other dashboard surfaces, framed as defense against quantified loss
 * rather than additive savings.
 *
 * Visual: three labeled $ amounts (subtle color per type) with a
 * thin proportional bar below showing the split. The bar makes the
 * loss-framing land viscerally — the eye sees the rose chunk before
 * reading any number. Tonally muted (200/300-weight colors, no
 * border) so it stays quieter than the KPI band.
 *
 * Hidden when the cohort has zero churn in the window (don't render
 * "$0 churned" — looks broken on a brand-new tenant).
 *
 * In-flight comes pre-computed from the API (churned − recovered −
 * lost, clamped ≥0) so the math always balances client-side. The
 * proportional bar uses raw cents as flex-grow values so segments
 * size correctly without explicit percentage math (and the right
 * edge stays flush — no rounding-induced gaps).
 */
function PipelineStrip({ pipeline }: { pipeline: Pipeline30d }) {
  if (pipeline.churnedMrrCents === 0) return null
  const fmt = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`
  return (
    <div className="mb-4 bg-slate-50 rounded-2xl px-5 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-y-1 gap-x-4 text-xs tabular-nums mb-2.5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-emerald-700">
            <span className="font-semibold">{fmt(pipeline.recoveredMrrCents)}</span>
            {' '}recovered
          </span>
          <span className="text-amber-700">
            <span className="font-semibold">{fmt(pipeline.inFlightMrrCents)}</span>
            {' '}in flight
          </span>
          <span className="text-rose-700">
            <span className="font-semibold">{fmt(pipeline.lostMrrCents)}</span>
            {' '}lost
          </span>
        </div>
        <span className="text-slate-500">
          <span className="font-semibold">{fmt(pipeline.churnedMrrCents)}</span>
          {' '}· 30d
        </span>
      </div>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="bg-emerald-300" style={{ flexGrow: pipeline.recoveredMrrCents }} />
        <div className="bg-amber-300" style={{ flexGrow: pipeline.inFlightMrrCents }} />
        <div className="bg-rose-300" style={{ flexGrow: pipeline.lostMrrCents }} />
      </div>
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
  loading,
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
  /** Spec 52 — true while the first /api/stats fetch is in flight. Shows a
   *  placeholder so we don't flash "0" / "$0" the moment after Subscribe
   *  redirects the merchant back to the dashboard. */
  loading?: boolean
}) {
  if (loading) {
    value = '—'
    delta = undefined
    sparkline = undefined
    subValue = undefined
  }
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
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-1">
        {label}
      </div>
      {subValue && (
        <div className="text-xs text-slate-500 tabular-nums mt-1.5">{subValue}</div>
      )}
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

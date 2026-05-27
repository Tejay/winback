'use client'

import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/status-badge'
import { Pagination } from '@/components/pagination'
import { SendPromoModal } from './promo/send-promo-modal'
import type { PromoOption } from './promo/promo-dropdown'
import { TrendingUp, CheckCircle, DollarSign, Users, Search, Zap, X, RotateCcw, Check, Loader2, Sparkles, MessageSquare, CreditCard, ChevronRight, ChevronDown, Copy, Mail, Send } from 'lucide-react'

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
  // DEPRECATED — Phase 1 of the drawer redesign replaced this. The
  // LLM no longer emits handoff/handoffReasoning; the column still
  // exists during the transition but values are always falsy on rows
  // classified post-migration. Removed in Phase 7 cleanup.
  handoffReasoning: string | null
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
  // Drawer insight — populated on every classification pass. Replaces
  // handoffReasoning as the founder-facing summary pinned above the
  // conversation. Migration 050.
  drawerInsightRead?: string | null
  drawerInsightWorthKnowing?: string | null
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
  // Spec 78 — short chip like "WINBACK25 · -25% × 3mo" if this
  // subscriber's recovery used a Stripe promotion code. Server-computed
  // in /api/subscribers from recoveries.appliedPromotionCodeId joined
  // to the promotion's wb_improvements row.
  appliedPromotionChip?: string | null
  // Spec 80 — subscriber's Stripe price id, used client-side by the
  // send-promo modal to pre-check which promos pass the
  // appliesToPriceIds gate (so the dropdown can grey out incompatible
  // promos before the merchant clicks send).
  stripePriceId?: string | null
  // Drawer redesign — the subscriber's most-recent inbound reply (shown
  // inline on awaiting rows) + whether the ball is in the founder's court.
  latestReplySnippet?: string | null
  awaitingReply?: boolean
}

type ConversationMessage =
  | {
      direction: 'outbound'
      id: string
      type: string
      subject: string | null
      bodyText: string | null
      sentAt: string
      repliedAt: string | null
    }
  | {
      direction: 'inbound'
      id: string
      body: string
      fromEmail: string | null
      receivedAt: string
      inReplyToEmailId: string | null
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
  awaiting: number
  high: number
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
    filterCounts: { all: 0, awaiting: 0, high: 0, recovered: 0, done: 0 },
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
  /** Spec 80 — list of merchant's published promotion improvements
   *  for the drawer "Send promo offer" modal. Empty array hides the
   *  action button. */
  promoOptions?: PromoOption[]
  /** Spec 80 — master promotions toggle. When false, the "Send promo
   *  offer" button is hidden regardless of how many promos are
   *  synced. */
  promotionsEnabled?: boolean
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
  promoOptions = [],
  promotionsEnabled = false,
}: DashboardClientProps) {
  const [stats, setStats] = useState<Stats>(EMPTY_STATS)
  // Spec 52 — `null` means "first fetch hasn't completed yet"; `[]` means
  // "loaded and empty". Lets the table avoid flashing the "No win-backs yet"
  // empty state during initial mount (most visible when navigating back from
  // /billing/success after Subscribe completes).
  const [subscribers, setSubscribers] = useState<Subscriber[] | null>(null)
  const [statsLoaded, setStatsLoaded] = useState(false)

  // Spec 73 — offset pagination.
  // Page is 1-indexed and hydrates from `?page=` on mount so browser back +
  // refresh + bookmarks land on the right page. PAGE_SIZE is intentionally
  // fixed (no UI selector) — keeps the merchant view clean. Power users can
  // still override via `?pageSize=` on the API directly.
  const router = useRouter()
  const searchParamsHook = useSearchParams()
  const PAGE_SIZE = 25
  const [page, setPage] = useState(() => {
    const p = Number.parseInt(searchParamsHook?.get('page') ?? '1', 10)
    return Number.isFinite(p) && p >= 1 ? p : 1
  })
  const [totalSubs, setTotalSubs] = useState(0)
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
  const [conversation, setConversation] = useState<ConversationMessage[] | null>(null)
  const [conversationLoading, setConversationLoading] = useState(false)
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(new Set())
  const [detailsOpen, setDetailsOpen] = useState(false)
  useEffect(() => {
    // Reset on subscriber change so a new drawer always starts collapsed.
    setExpandedMessageIds(new Set())
    setDetailsOpen(false)
  }, [selected?.id])

  useEffect(() => {
    if (!selected?.id) {
      setConversation(null)
      setConversationLoading(false)
      return
    }
    const subscriberId = selected.id
    let cancelled = false
    setConversationLoading(true)
    fetch(`/api/subscribers/${subscriberId}/conversation`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return
        setConversation(Array.isArray(data?.messages) ? data.messages : [])
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[dashboard] conversation fetch failed:', err)
        setConversation([])
      })
      .finally(() => {
        if (!cancelled) setConversationLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected?.id])

  // While a drawer is open, silently re-poll its conversation so a new
  // inbound reply (or AI re-classification) appears without reopening it.
  // Silent = no loading spinner, no blanking on error — just swap in fresh
  // messages. Visibility-gated; also fires immediately on tab focus.
  useEffect(() => {
    if (!selected?.id) return
    const id = selected.id
    let stopped = false
    const poll = () => {
      if (document.visibilityState !== 'visible') return
      fetch(`/api/subscribers/${id}/conversation`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!stopped && data && Array.isArray(data.messages)) setConversation(data.messages)
        })
        .catch(() => {})
    }
    const interval = setInterval(poll, 12000)
    window.addEventListener('focus', poll)
    document.addEventListener('visibilitychange', poll)
    return () => {
      stopped = true
      clearInterval(interval)
      window.removeEventListener('focus', poll)
      document.removeEventListener('visibilitychange', poll)
    }
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
    // Spec 40 — partition by cohort. Filters (awaiting / high / recovered /
    // done for win-back; dunning states for payment) go in the filter slot.
    params.set('cohort', tab === 'winback' ? 'winback' : 'payment-recovery')
    if (filter !== 'all') {
      params.set('filter', filter)
    }
    if (search) params.set('search', search)
    // Spec 73 — offset pagination. Server returns { rows, total, page, pageSize }.
    params.set('page',     String(page))
    params.set('pageSize', String(PAGE_SIZE))
    fetch(`/api/subscribers?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (data && Array.isArray(data.rows) && typeof data.total === 'number') {
          setSubscribers(data.rows)
          setTotalSubs(data.total)
        } else {
          console.warn('[dashboard] /api/subscribers returned unexpected shape:', data)
          setSubscribers([])
          setTotalSubs(0)
        }
      })
      .catch((err) => {
        console.error('[dashboard] /api/subscribers fetch failed:', err)
        setSubscribers([]) // show "No win-backs yet" rather than blank loading state
        setTotalSubs(0)
      })
  }, [tab, filter, search, page])

  useEffect(() => { fetchData() }, [fetchData])

  // Keep the list + KPIs live: refresh on a gentle interval and immediately
  // when the tab regains focus. This is what surfaces a brand-new inbound
  // reply (the "awaiting reply" state) without a manual reload — the common
  // flow is: founder replies in their email client, switches back here.
  // Visibility-gated so a backgrounded tab doesn't poll Neon for nothing.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') fetchData() }
    const interval = setInterval(refresh, 15000)
    window.addEventListener('focus', fetchData)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', fetchData)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [fetchData])

  // Spec 73 — reset to page 1 when filter / search / cohort changes. Skips
  // the first render so we don't overwrite a URL-hydrated `?page=N` on mount.
  // Without this, a merchant on page 5 who switches filters would land on
  // an empty page 5 of the new filtered result and have no idea what happened.
  const isFirstRender = useRef(true)
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
    setPage(1)
  }, [tab, filter, search])

  // Spec 73 — keep `?page=N` in the URL so back-button + refresh + bookmarks
  // land on the right page. Page 1 = no param (cleaner URL). `replace` (not
  // `push`) means paging through doesn't bloat browser history.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (page <= 1) params.delete('page')
    else params.set('page', String(page))
    const next = params.toString()
    const url  = `${window.location.pathname}${next ? `?${next}` : ''}`
    router.replace(url, { scroll: false })
  }, [page, router])

  // Spec 40 — switching tabs closes any open per-row UI on the previous tab:
  // collapse expanded payment-recovery row, close the win-back drawer.
  useEffect(() => {
    setExpandedRowId(null)
    setSelected(null)
  }, [tab])

  // Spec 51 — dismissBanner removed. Banner is server-derived; no
  // localStorage dismissal. Merchant subscribes or stays paused.

  // Subscribe button on the banner — routes through the new
  // /billing/activate page so the customer sees the MRR breakdown +
  // tier + price BEFORE any Stripe Checkout step. The old direct
  // setup-intent flow (jump straight to Stripe Checkout, blind card
  // capture, server-side commit) bypassed the dispute-proof surface
  // and is gone.
  const [subscribeError] = useState<string | null>(null)
  const [subscribing, setSubscribing] = useState(false)
  function handleSubscribe() {
    setSubscribing(true)
    window.location.href = '/billing/activate'
  }

  // Spec 80 — drawer "Send promo offer" modal state. Open when the
  // merchant clicks the action button on a churned subscriber drawer.
  // Modal owns its own form state; this just tracks visibility.
  const [promoModalOpen, setPromoModalOpen] = useState(false)

  // Drawer redesign — founder reply composer. 500-char Zod-enforced on
  // the server. On success, append the new outbound to the conversation
  // optimistically so the drawer reflects it before the refetch lands.
  const [replyDraft, setReplyDraft] = useState('')
  const [replySending, setReplySending] = useState(false)
  const [replyError, setReplyError] = useState<string | null>(null)
  // No draft persistence by design — close the drawer = lose unsent text.
  useEffect(() => { setReplyDraft(''); setReplyError(null) }, [selected?.id])

  async function handleFounderReply(id: string) {
    const body = replyDraft.trim()
    if (!body || body.length > 500) return
    setReplySending(true)
    setReplyError(null)
    try {
      const res = await fetch(`/api/subscribers/${id}/founder-reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      // Optimistic: append a synthetic outbound so the conversation
      // re-renders with the new message immediately. The next fetch
      // replaces it with the canonical row from the conversation API.
      const data = await res.json().catch(() => ({}))
      setConversation((prev) => prev
        ? [...prev, {
            direction: 'outbound' as const,
            id: data.messageId ?? `local-${Date.now()}`,
            type: 'founder_reply',
            subject: null,
            bodyText: body,
            sentAt: new Date().toISOString(),
            repliedAt: null,
          }]
        : prev)
      setReplyDraft('')
      // Re-fetch the conversation to pick up the canonical row.
      if (selected?.id === id) {
        fetch(`/api/subscribers/${id}/conversation`)
          .then((r) => r.ok ? r.json() : null)
          .then((d) => { if (d?.messages) setConversation(d.messages) })
          .catch(() => {})
      }
    } catch (err) {
      setReplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setReplySending(false)
    }
  }

  // Spec 22b + Spec 40 — AI-state filters for win-back cohort, dunning-
  // state filters for payment-recovery cohort. Each tab keeps its own
  // filter state so switching tabs doesn't lose context.
  const winbackFilters: Array<{ key: string; label: string }> = [
    { key: 'all',       label: 'All' },
    { key: 'awaiting',  label: 'Awaiting reply' },
    { key: 'high',      label: 'High recovery' },
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
            {subscribing ? 'Loading…' : 'Review and subscribe →'}
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

      {/* Win-back tab. Reading order top→bottom:
          pipeline strip (loss framing) → KPI cards → pattern strip →
          subscriber table. The legacy "needs your attention" handoff
          alert was removed — the AI no longer escalates a queue; the
          "Awaiting reply" filter + inline reply snippets surface what
          needs the founder now. */}
      {tab === 'winback' && (
        <>
          <PipelineStrip pipeline={stats.winBack.pipeline30d} />
          {/* KPI cards — clean white cards on the page background */}
          <section className="mb-7">
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
        <div className="bg-white rounded-2xl border border-slate-100 overflow-x-auto shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50/60 border-b border-slate-100">
                <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 py-3 pl-5 pr-4">Subscriber</th>
                <th className="hidden lg:table-cell text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 py-3 px-4">Plan</th>
                <th className="hidden sm:table-cell text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 py-3 px-4">Cancelled</th>
                <th className="hidden md:table-cell text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 py-3 px-4">Reason</th>
                <th className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 py-3 px-4">Status</th>
                <th className="text-right text-[11px] font-semibold uppercase tracking-wider text-slate-400 py-3 pr-5">MRR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {(subscribers ?? []).map((sub) => {
                const isClosed = sub.status === 'recovered' || sub.status === 'lost' || sub.status === 'skipped' || !!sub.doNotContact
                const initial = (sub.name?.trim()?.[0] ?? sub.email?.trim()?.[0] ?? '?').toUpperCase()
                const showSnippet = !!(sub.awaitingReply && sub.latestReplySnippet)
                const avatarClass =
                  sub.status === 'recovered' ? 'bg-emerald-50 text-emerald-700'
                  : sub.recoveryLikelihood === 'high' ? 'bg-gradient-to-br from-amber-200 to-amber-300 text-amber-900'
                  : 'bg-slate-100 text-slate-500'
                const snippet = (sub.latestReplySnippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
                return (
                <tr
                  key={sub.id}
                  onClick={() => setSelected(sub)}
                  className="hover:bg-slate-50/70 cursor-pointer transition-colors"
                >
                  <td className="py-3.5 pl-3 pr-4">
                    <div className="flex items-center gap-2.5">
                      {/* Unread-style dot — marks "the ball's in your court"
                          before you even read the snippet. Reserved slot keeps
                          avatars aligned whether or not the dot shows. */}
                      <span className="w-2 flex justify-center shrink-0">
                        {showSnippet && <span className="w-2 h-2 rounded-full bg-amber-400" title="Awaiting your reply" />}
                      </span>
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${avatarClass}`}>{initial}</div>
                      <div className="min-w-0">
                        <div className={`text-sm text-slate-900 leading-tight ${showSnippet ? 'font-bold' : 'font-medium'}`}>{sub.name ?? 'Unknown'}</div>
                        {showSnippet ? (
                          // Block + truncate (not flex) so a long reply — which may
                          // include quoted thread text — clips with an ellipsis
                          // instead of stretching the column and pushing MRR off-screen.
                          <div className="text-xs text-amber-700 mt-0.5 truncate max-w-[200px]">
                            <MessageSquare className="w-3 h-3 inline-block align-[-2px] mr-1" />
                            “{snippet}”
                          </div>
                        ) : (
                          <div className="text-xs text-slate-400 mt-0.5 truncate max-w-[200px]">{sub.email ?? ''}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="hidden lg:table-cell text-sm text-slate-600 py-3.5 px-4">{sub.planName ?? '—'}</td>
                  <td className="hidden sm:table-cell text-sm text-slate-500 py-3.5 px-4">
                    {sub.cancelledAt ? new Date(sub.cancelledAt).toISOString().split('T')[0] : '—'}
                  </td>
                  <td className="hidden md:table-cell text-sm text-slate-600 py-3.5 px-4 align-top">
                    <div className="max-w-[180px]">
                      {sub.cancellationReason
                        ? sub.cancellationReason.length > 45
                          ? sub.cancellationReason.slice(0, 45) + '…'
                          : sub.cancellationReason
                        : '—'}
                    </div>
                    {sub.appliedPromotionChip && (
                      <div className="mt-1">
                        {/* Spec 78 — promo chip on its own line under the reason. */}
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 text-[11px] font-medium">
                          {sub.appliedPromotionChip}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="py-3.5 px-4">
                    {(() => {
                      // Closed states get a single neutral chip (recovered is
                      // emerald). Recovery + ownership are irrelevant once done.
                      if (isClosed) {
                        if (sub.status === 'recovered') {
                          return (
                            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">✓ Recovered</span>
                          )
                        }
                        const closedLabel = sub.doNotContact ? 'Unsubscribed' : sub.status === 'lost' ? 'Lost' : 'Skipped'
                        return (
                          <span className="inline-flex items-center text-[11px] font-medium text-slate-500 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-full">
                            {closedLabel}
                          </span>
                        )
                      }
                      // Open states: recovery-likelihood chip (paint, not gate).
                      // "Awaiting reply" is conveyed by the reply snippet under
                      // the name, not a second chip.
                      const rl = sub.recoveryLikelihood
                      if (!rl) return <span className="text-xs text-slate-300">—</span>
                      const chip =
                        rl === 'high'   ? { dot: 'bg-emerald-500', cls: 'text-emerald-700 bg-emerald-50 border-emerald-200', label: 'High' }
                        : rl === 'medium' ? { dot: 'bg-amber-400',   cls: 'text-amber-700 bg-amber-50 border-amber-200',     label: 'Medium' }
                        :                   { dot: 'bg-slate-300',   cls: 'text-slate-500 bg-slate-50 border-slate-200',     label: 'Low' }
                      return (
                        <span className={`inline-flex items-center gap-1 text-[11px] font-semibold border px-2 py-0.5 rounded-full ${chip.cls}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${chip.dot}`} />
                          {chip.label}
                        </span>
                      )
                    })()}
                  </td>
                  <td className={`text-sm font-semibold tabular-nums py-3.5 pr-5 text-right ${sub.status === 'recovered' ? 'text-emerald-700' : 'text-slate-900'}`}>
                    ${(sub.mrrCents / 100).toFixed(2)}
                  </td>
                </tr>
                )
              })}
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

      {/* Spec 73 — pagination control. Renders only when total > pageSize
          (handled inside the component). Applies to both cohort tables. */}
      <Pagination
        total={totalSubs}
        page={page}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
        itemLabel={tab === 'winback' ? 'subscribers' : 'recoveries'}
      />

      {/* Subscriber detail panel — block layout (drawer redesign Phase 5).
          Blocks separated by hairline dividers: identity · AI insight ·
          conversation · reply composer · footer. The AI sends one listen-
          only exit email then stays quiet; the founder can reply at any
          time from the composer below (no take-over step). */}
      {selected && (() => {
        const hasInsight = !!(selected.drawerInsightRead || selected.drawerInsightWorthKnowing)
        const replyOver = replyDraft.length > 500
        const firstInitial = (selected.name?.trim()?.[0] ?? selected.email?.trim()?.[0] ?? '?').toUpperCase()
        return (
        <>
          <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setSelected(null)} />
          <div className="fixed right-0 top-0 h-full w-full sm:w-[420px] bg-white shadow-xl border-l border-slate-100 z-50 overflow-y-auto">

            {/* Block 1: identity — name + email + MRR + recovery chip */}
            <div className="px-5 pt-5 pb-4 flex items-start gap-3">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-amber-200 text-amber-900 text-sm font-semibold shrink-0">
                {firstInitial}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-slate-900 truncate">{selected.name ?? 'Unknown'}</div>
                    <div className="text-xs text-slate-500 truncate mt-0.5">{selected.email ?? '(no email on file)'}</div>
                  </div>
                  <button
                    onClick={() => setSelected(null)}
                    className="w-7 h-7 -mr-1 -mt-1 rounded-full hover:bg-slate-100 flex items-center justify-center text-slate-400 hover:text-slate-700 shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-900 tabular-nums">
                    ${(selected.mrrCents / 100).toFixed(0)}<span className="text-xs text-slate-400 font-medium">/mo</span>
                  </span>
                  {selected.recoveryLikelihood === 'high' && (
                    <>
                      <span className="text-slate-300">·</span>
                      <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-semibold text-amber-900 bg-amber-100 border border-amber-200 px-2 py-0.5 rounded-full">
                        High recovery
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Block 2: Spec 80 — manual promo offer action. Hidden when
                the master promotions toggle is off OR no promos are
                synced — both states make the action a no-op. Always
                available regardless of auto-mode (VIP override). */}
            {promotionsEnabled && promoOptions.length > 0 && (
              <div className="px-5 py-3 border-t border-slate-100">
                <button
                  onClick={() => setPromoModalOpen(true)}
                  className="w-full inline-flex items-center justify-center gap-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg py-2 transition-colors"
                >
                  <DollarSign className="w-4 h-4" />
                  Send promo offer
                </button>
              </div>
            )}

            {/* Block 3: AI insight — Read + Worth knowing */}
            {hasInsight && (
              <div className="px-5 py-3 border-t border-slate-100">
                <div className="rounded-xl bg-violet-50 border border-violet-200/60 p-3.5 flex items-start gap-2.5">
                  <div className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-violet-600 text-white text-[10px] font-bold shrink-0 mt-0.5">AI</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wider font-semibold text-violet-700 mb-1">Insight</div>
                    <div className="text-[13px] text-slate-800 leading-relaxed space-y-1">
                      {selected.drawerInsightRead && (
                        <div><span className="text-violet-700 font-semibold">Read.</span> {selected.drawerInsightRead}</div>
                      )}
                      {selected.drawerInsightWorthKnowing && (
                        <div><span className="text-violet-700 font-semibold">Worth knowing.</span> {selected.drawerInsightWorthKnowing}</div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Block 4: conversation (hidden when Details is open — replaced
                by the Details panel below) */}
            {!detailsOpen && (
            <div className="px-5 py-4 border-t border-slate-100">
              <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-3">
                Conversation
                {conversation && conversation.length > 0 && (
                  <span className="ml-1.5 text-slate-400 normal-case tracking-normal">· {conversation.length} message{conversation.length === 1 ? '' : 's'}</span>
                )}
              </div>

              {conversationLoading && conversation === null ? (
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
                </div>
              ) : !conversation || conversation.length === 0 ? (
                <p className="text-sm text-slate-400">
                  No messages yet. AI will send the first one automatically.
                </p>
              ) : (
                <ol className="space-y-2">
                  {conversation.map((m) => {
                    const expanded = expandedMessageIds.has(m.id)
                    const toggle = () => {
                      setExpandedMessageIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(m.id)) next.delete(m.id)
                        else next.add(m.id)
                        return next
                      })
                    }
                    const ts = m.direction === 'outbound' ? m.sentAt : m.receivedAt
                    const dateLabel = new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    const timeLabel = new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
                    if (m.direction === 'outbound') {
                      const hasBody = !!m.bodyText && m.bodyText.trim().length > 0
                      const title = m.subject ?? '(no subject)'
                      const isFounderSent = m.type === 'founder_reply'
                      const senderLabel = isFounderSent ? 'You · sent personally' : `AI · sent on your behalf · ${m.type}`
                      return (
                        <li key={m.id} className="border border-slate-200 rounded-xl bg-white">
                          <button type="button" onClick={toggle} className="w-full flex items-start gap-3 p-3 text-left">
                            <span className="mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-900 text-white text-[10px] font-semibold shrink-0">
                              {isFounderSent ? firstInitial : 'AI'}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                                <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{senderLabel}</span>
                                <span className="text-[10px] text-slate-400">{dateLabel} · {timeLabel}</span>
                                {m.repliedAt && (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">replied</span>
                                )}
                              </div>
                              <div className="text-sm text-slate-800 truncate">{title}</div>
                            </div>
                            {hasBody && (
                              <ChevronDown className={`w-3.5 h-3.5 text-slate-400 mt-1.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                            )}
                          </button>
                          {expanded && hasBody && (
                            <div className="px-3 pb-3 -mt-1">
                              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">{m.bodyText}</p>
                            </div>
                          )}
                        </li>
                      )
                    }
                    return (
                      <li key={m.id} className="border border-indigo-200 bg-indigo-50/40 rounded-xl">
                        <button type="button" onClick={toggle} className="w-full flex items-start gap-3 p-3 text-left">
                          <span className="mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-[10px] font-semibold shrink-0">
                            {firstInitial}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-[10px] uppercase tracking-wider text-indigo-700 font-semibold">Them</span>
                              <span className="text-[10px] text-slate-400">{dateLabel} · {timeLabel}</span>
                            </div>
                            <div className="text-sm text-slate-800 truncate">{m.body}</div>
                          </div>
                          <ChevronDown className={`w-3.5 h-3.5 text-slate-400 mt-1.5 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                        </button>
                        {expanded && (
                          <div className="px-3 pb-3 -mt-1">
                            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">{m.body}</p>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
            )}

            {/* Block 4-alt: when Details is open, conversation + composer
                collapse to a one-line breadcrumb so the Details panel can
                take the focus. */}
            {detailsOpen && (
              <div className="px-5 py-3 border-t border-slate-100">
                <div className="bg-slate-50 border border-slate-200 rounded-xl px-3.5 py-2.5 flex items-center justify-between text-[11px]">
                  <span className="text-slate-600">
                    <span className="font-semibold text-slate-900">Conversation</span>
                    {conversation && conversation.length > 0 && (
                      <> · {conversation.length} message{conversation.length === 1 ? '' : 's'}</>
                    )}
                  </span>
                  <button
                    onClick={() => setDetailsOpen(false)}
                    className="text-slate-500 hover:text-slate-900 flex items-center gap-0.5"
                  >
                    ↑ Back to chat
                  </button>
                </div>
              </div>
            )}

            {/* Block X: Details panel (AI's full read + Account) */}
            {detailsOpen && (
              <>
                <div className="px-5 py-4 border-t border-slate-100 bg-slate-50/40">
                  <div className="flex items-baseline justify-between mb-3">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">AI's full read</div>
                  </div>
                  <div className="grid grid-cols-2 gap-y-2 text-[12px]">
                    {selected.tier != null && (<>
                      <div className="text-slate-500">Tier</div>
                      <div className="text-slate-900 font-medium tabular-nums">{selected.tier}</div>
                    </>)}
                    {selected.cancellationCategory && (<>
                      <div className="text-slate-500">Category</div>
                      <div className="text-slate-900 font-medium">{selected.cancellationCategory}</div>
                    </>)}
                    {selected.confidence != null && (<>
                      <div className="text-slate-500">Confidence</div>
                      <div className="text-slate-900 font-medium tabular-nums">{Math.round(Number(selected.confidence) * 100)}%</div>
                    </>)}
                    {selected.triggerKeyword && (<>
                      <div className="text-slate-500">Trigger keyword</div>
                      <div className="text-slate-900 font-medium">{selected.triggerKeyword}</div>
                    </>)}
                    {selected.recoveryLikelihood && (<>
                      <div className="text-slate-500">Recovery</div>
                      <div className={
                        selected.recoveryLikelihood === 'high'  ? 'text-amber-700 font-medium' :
                        selected.recoveryLikelihood === 'medium'? 'text-slate-700 font-medium' :
                                                                   'text-slate-500 font-medium'
                      }>{selected.recoveryLikelihood}</div>
                    </>)}
                  </div>
                  {selected.triggerNeed && (
                    <div className="mt-3 pt-3 border-t border-slate-200">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Trigger need</div>
                      <div className="text-[12px] text-slate-700 leading-relaxed">{selected.triggerNeed}</div>
                    </div>
                  )}
                </div>

                <div className="px-5 py-4 border-t border-slate-100 bg-slate-50/40">
                  <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-3">Account</div>
                  <div className="grid grid-cols-2 gap-y-2 text-[12px]">
                    <div className="text-slate-500">Plan</div>
                    <div className="text-slate-700">{selected.planName ?? '—'}</div>
                    <div className="text-slate-500">Cancelled</div>
                    <div className="text-slate-700">
                      {selected.cancelledAt
                        ? new Date(selected.cancelledAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
                        : '—'}
                    </div>
                    <div className="text-slate-500">Tenure</div>
                    <div className="text-slate-700">
                      {selected.tenureDays != null
                        ? selected.tenureDays >= 30
                          ? `${Math.round(selected.tenureDays / 30)} months`
                          : `${selected.tenureDays} days`
                        : '—'}
                    </div>
                    <div className="text-slate-500">Status</div>
                    <div className="text-slate-700">{selected.status}</div>
                  </div>
                </div>
              </>
            )}

            {/* Block 5: reply composer — always available (no take-over step).
                Hidden only when Details is open, or there's no email / the
                subscriber unsubscribed (server rejects those anyway). */}
            {!detailsOpen && selected.email && !selected.doNotContact && (
              <div className="px-5 py-4 border-t border-slate-100">
                <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-2">Your reply</div>
                <div className="border border-slate-200 rounded-xl bg-white overflow-hidden focus-within:border-slate-300">
                  <textarea
                    value={replyDraft}
                    onChange={(e) => setReplyDraft(e.target.value)}
                    disabled={replySending}
                    rows={4}
                    placeholder="Write your reply…"
                    className="w-full px-3.5 pt-3 pb-2 text-[13px] text-slate-800 leading-relaxed focus:outline-none resize-none placeholder:text-slate-400 disabled:opacity-60"
                  />
                  <div className="px-3.5 py-2 border-t border-slate-100 bg-slate-50/60 text-[10px] text-slate-500 flex items-center justify-between">
                    <span className="truncate">↓ auto-appends reactivate · sign-off · unsubscribe</span>
                    <span className={`tabular-nums font-medium ml-2 shrink-0 ${replyOver ? 'text-red-600' : 'text-slate-400'}`}>
                      {replyDraft.length} / 500
                    </span>
                  </div>
                </div>
                {replyError && (
                  <div className="text-[11px] text-red-600 mt-2">{replyError}</div>
                )}
                <div className="flex items-center justify-end mt-3">
                  <button
                    onClick={() => handleFounderReply(selected.id)}
                    disabled={replySending || replyDraft.trim().length === 0 || replyOver}
                    className="bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-full px-4 py-2 text-xs font-semibold flex items-center gap-1.5"
                  >
                    {replySending ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Sending…
                      </>
                    ) : (
                      <>
                        Send reply <Send className="w-3 h-3" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* Block 6: quiet footer with Details toggle */}
            <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between text-[11px]">
              <span className="text-slate-400">
                {selected.cancelledAt
                  ? `Cancelled ${new Date(selected.cancelledAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                  : 'Cancelled —'}
                <span className="text-slate-300 mx-1.5">·</span>
                {selected.status}
              </span>
              <button
                onClick={() => setDetailsOpen((v) => !v)}
                className="text-slate-500 hover:text-slate-900 font-medium flex items-center gap-1"
              >
                {detailsOpen ? 'Hide details' : 'Details'}
                <ChevronDown className={`w-3 h-3 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>

          </div>
        </>
        )
      })()}

      {/* Spec 80 — manual promo modal. Rendered at the root so it
          floats above the drawer rather than inside it. Reads
          selected subscriber from parent state; modal owns its own
          form. */}
      {selected && (
        <SendPromoModal
          open={promoModalOpen}
          subscriber={{
            id:                 selected.id,
            name:               selected.name,
            email:              selected.email,
            daysSinceCancel:    selected.cancelledAt
              ? Math.floor((Date.now() - new Date(selected.cancelledAt).getTime()) / (1000 * 60 * 60 * 24))
              : null,
            planLabel:          `$${(selected.mrrCents / 100).toFixed(0)}/mo`,
            stripePriceId:      selected.stripePriceId ?? null,
            cancellationReason: selected.cancellationReason ?? null,
          }}
          promos={promoOptions}
          onClose={() => setPromoModalOpen(false)}
          onSent={() => {
            // Refresh the subscriber list so the recently-contacted
            // status flips and any chip eventually shows.
            fetchData()
          }}
        />
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
  // Activation-celebration banner. Fires on the dashboard when a
  // delivered recovery exists but the customer has no active platform
  // subscription. Treats the moment as a proof-of-value win, NOT as a
  // service-interruption alert. Confetti fires once on first mount so
  // the customer feels the moment — reloading the page doesn't re-fire
  // (sessionStorage flag keyed by mounted-banner).
  const showCelebration = !everSubscribed && firstRecovery.mrrCents > 0
  const recoveredName = firstRecovery.name ?? 'Your first subscriber'
  const recoveredMrrUsd = (firstRecovery.mrrCents / 100).toFixed(0)
  const atRiskAnnualUsd = Math.round(atRiskMrrAnnualizedCents / 100).toLocaleString()

  const moreNoun =
    atRiskCount === 1 ? 'more in your queue' : `${atRiskCount} more in your queue`

  const headline = everSubscribed
    ? 'Another save just landed.'
    : 'Your first save just landed.'
  const subhead =
    atRiskCount > 0
      ? `Subscribe to keep going on the ${moreNoun}.`
      : 'Subscribe to keep WinbackFlow running.'
  const ctaLabel = everSubscribed ? 'Re-subscribe →' : 'Review and subscribe →'

  // Confetti — fires once per session per banner mount. Imports the
  // package lazily so the dashboard's initial JS bundle doesn't pay the
  // cost for users who never see this banner.
  useEffect(() => {
    const flag = 'wb_first_save_celebrated'
    if (typeof window === 'undefined') return
    if (window.sessionStorage.getItem(flag) === '1') return
    window.sessionStorage.setItem(flag, '1')
    let cancelled = false
    void import('canvas-confetti').then((mod) => {
      if (cancelled) return
      const confetti = mod.default
      // Two angled bursts from bottom corners — feels like cheering
      // from the wings, not a single flat shower from the top.
      const fire = (angle: number, origin: { x: number; y: number }) =>
        confetti({
          particleCount: 80,
          spread: 70,
          angle,
          startVelocity: 55,
          decay: 0.92,
          gravity: 0.9,
          ticks: 220,
          origin,
          colors: ['#10b981', '#3b82f6', '#fbbf24', '#ef4444', '#a855f7'],
        })
      fire(60, { x: 0.15, y: 0.7 })
      fire(120, { x: 0.85, y: 0.7 })
    }).catch(() => { /* never break the page on a celebration failure */ })
    return () => { cancelled = true }
  }, [])

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
      className="relative overflow-hidden bg-gradient-to-br from-emerald-50 via-white to-blue-50 border-2 border-emerald-400 rounded-2xl p-7 mb-6 shadow-sm"
      style={{ animation: 'wb-slide-in 420ms cubic-bezier(0.2, 0.9, 0.32, 1.12) both' }}
    >
      {/* Subtle decorative glows */}
      <div aria-hidden className="pointer-events-none">
        <div className="absolute -top-16 -right-16 w-56 h-56 bg-emerald-200/40 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-16 -left-16 w-40 h-40 bg-blue-200/30 rounded-full blur-3xl"></div>
      </div>

      <style>{`
        @keyframes wb-slide-in {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes wb-emoji-pop {
          0%   { transform: scale(0.3) rotate(-20deg); opacity: 0; }
          50%  { transform: scale(1.25) rotate(8deg); opacity: 1; }
          100% { transform: scale(1) rotate(0deg); opacity: 1; }
        }
      `}</style>

      <div className="relative">
        <div className="flex items-start gap-3 mb-4">
          <span
            className="text-2xl leading-none flex-shrink-0 inline-block"
            style={{ animation: 'wb-emoji-pop 700ms cubic-bezier(0.34, 1.56, 0.64, 1) both' }}
          >
            🎉
          </span>
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
            {subscribing ? 'Loading…' : ctaLabel}
          </button>
          <span className="text-xs text-slate-500">
            Flat monthly fee priced by your MRR · Cancel anytime, no retention friction
          </span>
        </div>
        {error && (
          <p className="text-xs text-red-600 mt-3">
            Couldn&apos;t continue to billing: {error}. Try again, or contact support if it persists.
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
    <div className="bg-white rounded-2xl border border-slate-100 p-5 transition-shadow hover:shadow-[0_8px_26px_-10px_rgba(15,23,42,0.14)]">
      <div className="flex items-start justify-between">
        <div className={`${accentClass} rounded-xl w-8 h-8 flex items-center justify-center`}>
          {icon}
        </div>
        {sparkline && sparkline.length > 0 && (
          <Sparkline data={sparkline} accent={accent} />
        )}
        {!sparkline && delta && (
          <span className={`text-[11px] font-semibold tabular-nums ${deltaClass}`}>
            {delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : ''} {delta.text}
          </span>
        )}
      </div>
      <div className="text-3xl font-bold tracking-tight text-slate-900 mt-3 tabular-nums">{value}</div>
      <div className="text-[13px] text-slate-400 mt-1">{label}</div>
      {subValue && (
        <div className="text-xs text-slate-500 tabular-nums mt-1.5">{subValue}</div>
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

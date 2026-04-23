'use client'

import { useState, useEffect, useCallback } from 'react'
import { StatusBadge } from '@/components/status-badge'
import { AiStateBadge } from '@/components/ai-state-badge'
import { TrendingUp, CheckCircle, DollarSign, Users, Search, Zap, X, RotateCcw, Check, Loader2, Sparkles } from 'lucide-react'

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
  stripeComment: string | null
  replyText: string | null
  triggerKeyword: string | null
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
}

interface Stats {
  recoveryRate: number
  recovered: number
  mrrRecoveredCents: number
  pending: number
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
}

export function DashboardClient({ changelog, isTrial, firstRecovery }: DashboardClientProps) {
  const [stats, setStats] = useState<Stats>({ recoveryRate: 0, recovered: 0, mrrRecoveredCents: 0, pending: 0 })
  const [subscribers, setSubscribers] = useState<Subscriber[]>([])
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
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

  // Poll backfill status while in progress
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null

    function pollBackfill() {
      fetch('/api/backfill/status')
        .then((r) => r.json())
        .then((data: BackfillStatus) => {
          setBackfill(data)
          if (data.complete && interval) {
            clearInterval(interval)
            interval = null
            // Refresh subscriber list when backfill finishes
            fetchData()
          }
        })
        .catch(() => {})
    }

    pollBackfill()
    interval = setInterval(pollBackfill, 3000)

    return () => { if (interval) clearInterval(interval) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchData = useCallback(() => {
    fetch('/api/stats').then((r) => r.json()).then(setStats)
    const params = new URLSearchParams()
    if (filter !== 'all') params.set('filter', filter)
    if (search) params.set('search', search)
    fetch(`/api/subscribers?${params}`).then((r) => r.json()).then(setSubscribers)
  }, [filter, search])

  useEffect(() => { fetchData() }, [fetchData])

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

  // Spec 22b — AI-state filters replacing raw status filters
  const filters: Array<{ key: string; label: string }> = [
    { key: 'all',       label: 'All' },
    { key: 'active',    label: 'AI active' },
    { key: 'handoff',   label: 'Needs you' },
    { key: 'paused',    label: 'Paused' },
    { key: 'recovered', label: 'Recovered' },
    { key: 'done',      label: 'Done' },
  ]
  const showBanner = isTrial && firstRecovery && !bannerDismissed

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

      {/* Billing alert */}
      {showBanner && (
        <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-6 flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="bg-blue-50 rounded-full p-2 flex-shrink-0">
              <Zap className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-900">
                🎉 Your first recovery is in{firstRecovery.name ? ` — ${firstRecovery.name} is back` : ''} at ${(firstRecovery.mrrCents / 100).toFixed(0)}/mo.
              </p>
              <p className="text-sm text-slate-600 mt-1">
                Add a payment method to keep recovering. Billing is{' '}
                <strong>15% of recovered revenue</strong> for 12 months per subscriber. No base fee.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3 sm:gap-4">
                <a href="/settings#billing" className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]">
                  Add billing to keep recovering
                </a>
                <button onClick={dismissBanner} className="text-sm text-slate-400 hover:text-slate-600">Not now</button>
              </div>
            </div>
          </div>
          <button onClick={dismissBanner} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
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

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 mb-6">
        <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <div className="bg-green-50 rounded-xl w-9 h-9 flex items-center justify-center text-green-600">
            <TrendingUp className="w-4 h-4" />
          </div>
          <div className="text-4xl font-bold text-slate-900 mt-3">{stats.recoveryRate}%</div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-1">Recovery Rate</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <div className="bg-green-50 rounded-xl w-9 h-9 flex items-center justify-center text-green-600">
            <CheckCircle className="w-4 h-4" />
          </div>
          <div className="text-4xl font-bold text-slate-900 mt-3">{stats.recovered}</div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-1">Recovered</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <div className="bg-green-50 rounded-xl w-9 h-9 flex items-center justify-center text-green-600">
            <DollarSign className="w-4 h-4" />
          </div>
          <div className="text-4xl font-bold text-slate-900 mt-3">${Math.round(stats.mrrRecoveredCents / 100)}</div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-1">MRR Recovered</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-100 p-6">
          <div className="bg-amber-50 rounded-xl w-9 h-9 flex items-center justify-center text-amber-600">
            <Users className="w-4 h-4" />
          </div>
          <div className="text-4xl font-bold text-slate-900 mt-3">{stats.pending}</div>
          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mt-1">Pending</div>
        </div>
      </div>

      {/* Filter tabs + search */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 md:gap-4 mb-4">
        <div className="flex items-center gap-1 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={
                filter === f.key
                  ? 'bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium'
                  : 'text-slate-500 hover:text-slate-900 rounded-full px-4 py-1.5 text-sm font-medium transition-colors'
              }
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative w-full md:w-auto">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search name, email, reason"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border border-slate-200 rounded-full px-4 py-2 text-sm w-full md:w-64 pl-10 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Subscriber table */}
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
                  No subscribers found. They&apos;ll appear here when cancellations come in from Stripe.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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

            {selected.cancellationReason && (
              <div className="mx-6 mt-4 bg-blue-50 rounded-xl p-4">
                <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">Cancellation Reason</div>
                <div className="text-sm font-medium text-slate-900 italic mb-1">{selected.cancellationReason}</div>
                {selected.cancellationCategory && (
                  <div className="text-xs text-slate-400">Category: {selected.cancellationCategory}</div>
                )}
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

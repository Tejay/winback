/**
 * Standalone demo-dashboard primitives + mock data + the two main exports
 * (<WinBackDemoDashboard /> and <PaymentRecoveryDemoDashboard />) used by
 * the prospect-facing /demo/win-back and /demo/payment-recovery pages.
 *
 * Why this file exists separately from app/dashboard/dashboard-client.tsx:
 * the live dashboard is tightly coupled to useEffect fetches against the
 * /api/stats and /api/subscribers endpoints. Refactoring it to accept
 * initialStats / initialSubscribers props for demo mode is a real refactor
 * that risks the live dashboard for a marketing-only feature. So we copy
 * the visual primitives here. ~600 lines, server-component-safe (no
 * useState / useEffect — drawer is always-open in the demo, no
 * interactions).
 *
 * Copy fidelity: same Tailwind classes, same proportions, same icons as
 * the live dashboard. If the live dashboard's visual style updates, this
 * file may drift; that's the trade-off for keeping the live code
 * untouched. Drift is a marketing maintenance task, not a product bug.
 */

import Link from 'next/link'
import { Fragment } from 'react'
import {
  MessageSquare,
  CreditCard,
  TrendingUp,
  CheckCircle,
  DollarSign,
  Users,
  Send,
  ChevronDown,
  Search,
  X,
} from 'lucide-react'

// ─────────────────────────────────────────────────────────────────────────
// Types — small subset of the live Subscriber type, just what the demo
// rows use.
// ─────────────────────────────────────────────────────────────────────────

type WinBackStatus = 'pending' | 'contacted' | 'recovered' | 'lost' | 'skipped'
type DunningState =
  | 'awaiting_retry'
  | 'final_retry_pending'
  | 'churned_during_dunning'
  | 'recovered_during_dunning'

interface WinBackRow {
  id: string
  name: string
  email: string
  planName: string
  mrrCents: number
  cancelledAt: string         // ISO date
  cancellationReason: string
  cancellationCategory: 'Price' | 'Feature' | 'Quality' | 'Switched' | 'Unused' | 'Other'
  tier: 1 | 2 | 3
  status: WinBackStatus
  // Drawer redesign — recovery-likelihood chip (paint, not a queue) +
  // inline "awaiting reply" snippet replace the removed handoff/"Needs you"
  // escalation. Mirrors the live dashboard's open-row status column.
  recoveryLikelihood?: 'high' | 'medium' | 'low'
  awaitingReply?: boolean
  latestReplySnippet?: string
}

interface PaymentRow {
  id: string
  name: string
  email: string
  planName: string
  mrrCents: number
  failedAt: string            // ISO date — anchor on createdAt in real data
  declineCode: 'insufficient_funds' | 'expired_card' | 'do_not_honor' | 'generic_decline'
  status: WinBackStatus       // 'recovered' | 'pending' | 'lost' usable here
  dunningState: DunningState | null
  dunningTouchCount?: number
}

export interface Pipeline30d {
  churnedMrrCents: number
  recoveredMrrCents: number
  inFlightMrrCents: number
  lostMrrCents: number
}

// ─────────────────────────────────────────────────────────────────────────
// Mock data — Aurora Analytics, the demo brand. Numbers tuned to feel
// like a healthy SaaS at ~$30K MRR with realistic monthly churn.
// ─────────────────────────────────────────────────────────────────────────

// Win-back at industry-realistic ~20% recovery rate (voluntary cancellations
// are HARD to recover — customer made a deliberate choice to leave).
export const WINBACK_PIPELINE: Pipeline30d = {
  churnedMrrCents:   1000000,  // $10,000
  recoveredMrrCents:  200000,  // $2,000  (20%)
  inFlightMrrCents:   500000,  // $5,000
  lostMrrCents:       300000,  // $3,000
}

export const WINBACK_KPI = {
  recoveryRate30d:        20,
  recoveredLifetime:      35,
  cumulativeRevenueCents: 980000,   // $9,800 lifetime saved
  activeMrrCents:         76000,    // $760/mo currently active
  inProgress:             12,
  recoveredThisMonth:     4,
  recoveredLastMonth:     3,
  mrrThisMonthCents:      36000,
  mrrLastMonthCents:      28000,
  // Sparkline — 30-day daily recovered count, gentle upward trend.
  dailyRecovered: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1],
}

const WINBACK_TOP_REASONS = [
  { label: 'Price',    pct: 32 },
  { label: 'Feature',  pct: 24 },
  { label: 'Switched', pct: 18 },
  { label: 'Other',    pct: 26 },
]

const WINBACK_FILTER_COUNTS = {
  all: 15, awaiting: 2, high: 4, price: 3, recovered: 3, done: 7,
}

const WINBACK_ROWS: WinBackRow[] = [
  {
    id: 'wb-1',
    name: 'Sarah Chen',
    email: 'sarah.chen@northpeak.io',
    planName: 'Pro',
    mrrCents: 14900,
    cancelledAt: '2026-04-30',
    cancellationReason: 'Switching to Mixpanel — better dashboards',
    cancellationCategory: 'Switched',
    tier: 3,
    status: 'contacted',
    recoveryLikelihood: 'high',
  },
  {
    id: 'wb-2',
    name: 'Marcus Patel',
    email: 'marcus@quietbox.app',
    planName: 'Growth',
    mrrCents: 9900,
    cancelledAt: '2026-04-28',
    cancellationReason: 'Honestly, $99/mo is just too much for what I’m getting right now',
    cancellationCategory: 'Price',
    tier: 2,
    status: 'contacted',
    recoveryLikelihood: 'high',
    awaitingReply: true,
    latestReplySnippet: 'Yeah, $49 would change my mind. Is that a real plan or are you just feeling it out?',
  },
  {
    id: 'wb-3',
    name: 'Emily Rodriguez',
    email: 'emily.r@thirdcoffee.co',
    planName: 'Pro',
    mrrCents: 14900,
    cancelledAt: '2026-04-26',
    cancellationReason: 'Missing per-segment dashboards',
    cancellationCategory: 'Feature',
    tier: 2,
    status: 'contacted',
    recoveryLikelihood: 'medium',
  },
  {
    id: 'wb-4',
    name: 'Liam Cohen',
    email: 'liam@stickleback.tech',
    planName: 'Growth',
    mrrCents: 9900,
    cancelledAt: '2026-04-25',
    cancellationReason: 'Building it in-house — outgrew the tool',
    cancellationCategory: 'Unused',
    tier: 3,
    status: 'lost',
  },
  {
    id: 'wb-5',
    name: 'Reese Kim',
    email: 'reese@pulsegrid.co',
    planName: 'Starter',
    mrrCents: 4900,
    cancelledAt: '2026-04-24',
    cancellationReason: 'Going to try Amplitude’s free tier',
    cancellationCategory: 'Switched',
    tier: 1,
    status: 'contacted',
    recoveryLikelihood: 'high',
  },
  {
    id: 'wb-6',
    name: 'Ava Morales',
    email: 'ava.m@yarrow.so',
    planName: 'Pro',
    mrrCents: 14900,
    cancelledAt: '2026-04-22',
    cancellationReason: 'Slow query performance on big datasets',
    cancellationCategory: 'Quality',
    tier: 2,
    status: 'lost',
  },
  {
    id: 'wb-7',
    name: 'Noah Brennan',
    email: 'noah.b@quietbox.app',
    planName: 'Starter',
    mrrCents: 1900,
    cancelledAt: '2026-04-21',
    cancellationReason: 'Just trying out a few alternatives',
    cancellationCategory: 'Other',
    tier: 1,
    status: 'pending',
    recoveryLikelihood: 'low',
  },
  {
    id: 'wb-8',
    name: 'Ethan Foster',
    email: 'ethan@midmornin.com',
    planName: 'Growth',
    mrrCents: 9900,
    cancelledAt: '2026-04-19',
    cancellationReason: 'Price increase last quarter pushed us over budget',
    cancellationCategory: 'Price',
    tier: 2,
    status: 'contacted',
    recoveryLikelihood: 'high',
    awaitingReply: true,
    latestReplySnippet: 'If you can hold our old rate for 6 months I’ll bring it back to the team.',
  },
  {
    id: 'wb-9',
    name: 'Casey Okafor',
    email: 'casey@lumencraft.io',
    planName: 'Pro',
    mrrCents: 14900,
    cancelledAt: '2026-04-17',
    cancellationReason: 'Need SAML SSO for our compliance review',
    cancellationCategory: 'Feature',
    tier: 3,
    status: 'lost',
  },
  {
    id: 'wb-10',
    name: 'Taylor Brennan',
    email: 'taylor@quietbox.app',
    planName: 'Growth',
    mrrCents: 9900,
    cancelledAt: '2026-04-14',
    cancellationReason: 'Team got laid off',
    cancellationCategory: 'Other',
    tier: 1,
    status: 'lost',
  },
  {
    id: 'wb-11',
    name: 'Ava Cohen',
    email: 'ava.cohen@quietbox.app',
    planName: 'Starter',
    mrrCents: 4900,
    cancelledAt: '2026-04-12',
    cancellationReason: 'Found a free alternative',
    cancellationCategory: 'Price',
    tier: 1,
    status: 'recovered',
  },
  {
    id: 'wb-12',
    name: 'Reese Andersson',
    email: 'reese.a@lumencraft.io',
    planName: 'Pro',
    mrrCents: 14900,
    cancelledAt: '2026-04-08',
    cancellationReason: 'Workflow doesn’t match our team’s ops',
    cancellationCategory: 'Other',
    tier: 2,
    status: 'lost',
  },
]

// The drawer is pre-opened on Marcus Patel — he's the most persuasive
// row to feature: mid-conversation, replied to our email, AI insight +
// the inline reply composer make the founder's next move obvious.
const WINBACK_SELECTED_ID = 'wb-2'

// ─────────────────────────────────────────────────────────────────────────

// Payment recovery at industry-realistic ~80% rate. Failed payments are
// involuntary — the customer wanted to stay, the card just broke.
// Stripe Smart Retries + a one-click update-payment email together
// recover the vast majority.
export const PAYMENT_PIPELINE: Pipeline30d = {
  churnedMrrCents:    720000,  // $7,200
  recoveredMrrCents:  580000,  // $5,800  (~80%)
  inFlightMrrCents:   120000,  // $1,200
  lostMrrCents:        20000,  // $200
}

export const PAYMENT_KPI = {
  recoveryRate30d:        80,
  recoveredLifetime:      124,
  cumulativeRevenueCents: 1950000,  // $19,500 lifetime saved
  activeMrrCents:         158000,   // $1,580/mo currently active
  inDunning:              6,
  recoveredThisMonth:     18,
  recoveredLastMonth:     14,
  mrrThisMonthCents:      158000,
  mrrLastMonthCents:      125000,
  dailyRecovered: [1, 1, 2, 1, 2, 2, 1, 2, 2, 1, 2, 3, 1, 1, 2, 2, 3, 2, 1, 2, 1, 2, 2, 3, 2, 2, 3, 1, 2, 3],
}

const PAYMENT_TOP_DECLINES = [
  { label: 'insufficient_funds', pct: 62 },
  { label: 'expired_card',       pct: 24 },
  { label: 'do_not_honor',       pct: 10 },
  { label: 'generic_decline',    pct: 4 },
]

const PAYMENT_FILTER_COUNTS = {
  all: 14, inRetry: 2, finalRetry: 1, recovered: 11, lost: 0,
}

const PAYMENT_ROWS: PaymentRow[] = [
  // Active retries first (sorted by next-retry urgency in the real product).
  // At ~80% recovery, only a handful are still in flight at any time.
  { id: 'pr-1',  name: 'Ava Rivera',       email: 'ava@thirdcoffee.co',         planName: 'Starter',  mrrCents: 2900,  failedAt: '2026-04-30', declineCode: 'do_not_honor',       status: 'pending', dunningState: 'awaiting_retry',      dunningTouchCount: 2 },
  { id: 'pr-2',  name: 'Ethan Morales',    email: 'ethan.m@yarrow.so',          planName: 'Growth',   mrrCents: 8900,  failedAt: '2026-04-27', declineCode: 'insufficient_funds', status: 'pending', dunningState: 'final_retry_pending', dunningTouchCount: 3 },
  { id: 'pr-3',  name: 'Alex Morales',     email: 'alex@midmornin.com',         planName: 'Growth',   mrrCents: 8900,  failedAt: '2026-04-29', declineCode: 'expired_card',       status: 'pending', dunningState: 'awaiting_retry',      dunningTouchCount: 2 },
  // Recovered — the bulk of the cohort.
  { id: 'pr-4',  name: 'Reese Kim',        email: 'reese@stickleback.tech',     planName: 'Pro',      mrrCents: 14900, failedAt: '2026-04-26', declineCode: 'expired_card',       status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-5',  name: 'Liam Cohen',       email: 'liam.c@quietbox.app',        planName: 'Starter',  mrrCents: 1900,  failedAt: '2026-04-28', declineCode: 'insufficient_funds', status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-6',  name: 'Reese Kim',        email: 'reese.k@pulsegrid.co',       planName: 'Growth',   mrrCents: 8900,  failedAt: '2026-05-01', declineCode: 'insufficient_funds', status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-7',  name: 'Reese Andersson',  email: 'reese@lumencraft.io',        planName: 'Growth',   mrrCents: 8900,  failedAt: '2026-04-25', declineCode: 'generic_decline',    status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-8',  name: 'Sienna Park',      email: 'sienna@northpeak.io',        planName: 'Starter',  mrrCents: 2900,  failedAt: '2026-04-24', declineCode: 'insufficient_funds', status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-9',  name: 'Owen Brennan',     email: 'owen@yarrow.so',             planName: 'Pro',      mrrCents: 14900, failedAt: '2026-04-23', declineCode: 'insufficient_funds', status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-10', name: 'Mira Patel',       email: 'mira@thirdcoffee.co',        planName: 'Growth',   mrrCents: 8900,  failedAt: '2026-04-22', declineCode: 'expired_card',       status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-11', name: 'Ava Morales',      email: 'ava@thirdcoffee.co',         planName: 'Starter',  mrrCents: 4900,  failedAt: '2026-04-26', declineCode: 'do_not_honor',       status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-12', name: 'Taylor Brennan',   email: 'taylor.b@quietbox.app',      planName: 'Starter',  mrrCents: 1900,  failedAt: '2026-04-22', declineCode: 'insufficient_funds', status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-13', name: 'Casey Okafor',     email: 'casey@lumencraft.io',        planName: 'Starter',  mrrCents: 1900,  failedAt: '2026-04-13', declineCode: 'expired_card',       status: 'recovered', dunningState: 'recovered_during_dunning' },
  { id: 'pr-14', name: 'Ava Cohen',        email: 'ava.cohen@quietbox.app',     planName: 'Pro',      mrrCents: 14900, failedAt: '2026-04-28', declineCode: 'expired_card',       status: 'recovered', dunningState: 'recovered_during_dunning' },
]

// Pre-expand Ethan Morales (Final retry — most-urgent state, perfect
// for showing the inline detail panel).
const PAYMENT_EXPANDED_ID = 'pr-2'

// ─────────────────────────────────────────────────────────────────────────
// Primitives — copied 1:1 from app/dashboard/dashboard-client.tsx.
// ─────────────────────────────────────────────────────────────────────────

const PATTERN_COLOR_MAP: Record<string, string> = {
  Price:    'bg-rose-50 text-rose-700',
  Feature:  'bg-blue-50 text-blue-700',
  Quality:  'bg-amber-50 text-amber-700',
  Switched: 'bg-violet-50 text-violet-700',
  Unused:   'bg-slate-100 text-slate-600',
  Other:    'bg-slate-100 text-slate-600',
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

export function PipelineStrip({ pipeline }: { pipeline: Pipeline30d }) {
  if (pipeline.churnedMrrCents === 0) return null
  const fmt = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`
  return (
    <div className="mb-4 bg-slate-50 rounded-2xl px-5 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-y-1 gap-x-4 text-xs tabular-nums mb-2.5">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-emerald-700">
            <span className="font-semibold">{fmt(pipeline.recoveredMrrCents)}</span>{' '}recovered
          </span>
          <span className="text-amber-700">
            <span className="font-semibold">{fmt(pipeline.inFlightMrrCents)}</span>{' '}in flight
          </span>
          <span className="text-rose-700">
            <span className="font-semibold">{fmt(pipeline.lostMrrCents)}</span>{' '}lost
          </span>
        </div>
        <span className="text-slate-500">
          <span className="font-semibold">{fmt(pipeline.churnedMrrCents)}</span>{' '}· 30d
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

export function StatCard({
  accent, icon, value, label, delta, sparkline, subValue,
}: {
  accent: 'blue' | 'green' | 'amber'
  icon: React.ReactNode
  value: string
  label: string
  delta?: { text: string; direction: 'up' | 'down' | 'flat' }
  sparkline?: number[]
  subValue?: string
}) {
  const accentClass =
    accent === 'blue'  ? 'bg-blue-50 text-blue-600'
    : accent === 'green' ? 'bg-green-50 text-green-600'
    : 'bg-amber-50 text-amber-600'
  const deltaClass =
    delta?.direction === 'up' ? 'text-emerald-600'
    : delta?.direction === 'down' ? 'text-rose-600'
    : 'text-slate-400'
  return (
    <div className="bg-white rounded-2xl border border-slate-100 px-4 py-4">
      <div className="flex items-start justify-between">
        <div className={`${accentClass} rounded-lg w-7 h-7 flex items-center justify-center`}>
          {icon}
        </div>
        {sparkline && sparkline.length > 0 && <Sparkline data={sparkline} accent={accent} />}
      </div>
      <div className="text-2xl sm:text-3xl font-bold text-slate-900 mt-2.5 tabular-nums">{value}</div>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mt-1">{label}</div>
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

function Sparkline({ data, accent }: { data: number[]; accent: 'blue' | 'green' | 'amber' }) {
  const w = 64, h = 22
  if (data.length === 0) return null
  const max = Math.max(...data, 1), min = Math.min(...data, 0)
  const range = max - min || 1
  const dx = w / Math.max(data.length - 1, 1)
  const points = data.map((v, i) => `${(i * dx).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ')
  const stroke = accent === 'blue' ? '#2563eb' : accent === 'green' ? '#16a34a' : '#d97706'
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
    </svg>
  )
}

function DunningStageBadge({ row }: { row: PaymentRow }) {
  if (row.status === 'recovered') {
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-green-50 text-green-700 border border-green-200">Recovered</span>
  }
  if (row.dunningState === 'final_retry_pending') {
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">Final retry</span>
  }
  if (row.dunningState === 'awaiting_retry') {
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">In retry · T{row.dunningTouchCount ?? 1}</span>
  }
  if (row.dunningState === 'churned_during_dunning') {
    return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">Lost</span>
  }
  return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium bg-slate-100 text-slate-500 border border-slate-200">{row.dunningState ?? '—'}</span>
}

export function formatDelta(curr: number, prev: number, kind: 'count' | 'money'): { text: string; direction: 'up' | 'down' | 'flat' } {
  const diff = curr - prev
  if (diff === 0) return { text: '—', direction: 'flat' }
  const sign = diff > 0 ? '+' : '−'
  const abs = Math.abs(diff)
  const value = kind === 'money' ? `$${Math.round(abs / 100).toLocaleString()}` : `${abs}`
  return { text: `${sign}${value}`, direction: diff > 0 ? 'up' : 'down' }
}

export const fmtUsd = (cents: number) => `$${Math.round(cents / 100).toLocaleString()}`

// ─────────────────────────────────────────────────────────────────────────
// Tab strip — matches the live dashboard's pill-button style. The
// inactive tab links to the sibling demo page so prospects can flip
// between win-back and payment-recovery in one click.
// ─────────────────────────────────────────────────────────────────────────

function TabStrip({ active }: { active: 'winback' | 'paymentRecovery' }) {
  return (
    <div className="flex items-center gap-3 mb-6">
      {active === 'winback' ? (
        <button
          type="button"
          className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold bg-blue-600 text-white shadow-sm cursor-default"
        >
          <MessageSquare className="w-4 h-4" />
          Win-backs
        </button>
      ) : (
        <Link
          href="/demo/win-back"
          className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
        >
          <MessageSquare className="w-4 h-4" />
          Win-backs
        </Link>
      )}
      {active === 'paymentRecovery' ? (
        <button
          type="button"
          className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-semibold bg-[#047857] text-white shadow-sm cursor-default"
        >
          <CreditCard className="w-4 h-4" />
          Payment recoveries
        </button>
      ) : (
        <Link
          href="/demo/payment-recovery"
          className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors"
        >
          <CreditCard className="w-4 h-4" />
          Payment recoveries
        </Link>
      )}
    </div>
  )
}

// Filter chips — visual only in the demo; the "All" chip is highlighted.
// Borderless pill style mirrors the live dashboard (dark fill when active,
// plain slate text otherwise).
function FilterChips({
  chips,
}: {
  chips: Array<{ label: string; count: number; active?: boolean }>
}) {
  return (
    <div className="flex items-center gap-1 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className={
            chip.active
              ? 'flex items-center gap-1.5 bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap'
              : 'flex items-center gap-1.5 text-slate-500 rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap'
          }
        >
          <span>{chip.label}</span>
          {chip.count > 0 && (
            <span className={chip.active ? 'tabular-nums text-white/70 text-xs' : 'tabular-nums text-slate-400 text-xs'}>
              {chip.count}
            </span>
          )}
        </span>
      ))}
    </div>
  )
}

// Cosmetic search box — styled like the live one, no behavior.
function DemoSearch({ placeholder }: { placeholder: string }) {
  return (
    <div className="relative w-full md:w-64">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
      <input
        type="text"
        placeholder={placeholder}
        readOnly
        aria-label="Search (demo only)"
        className="border border-slate-200 rounded-full px-4 py-2 text-sm w-full pl-10 bg-white text-slate-400 cursor-default"
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Win-back demo dashboard
// ─────────────────────────────────────────────────────────────────────────

export function WinBackDemoDashboard() {
  const selected = WINBACK_ROWS.find((r) => r.id === WINBACK_SELECTED_ID)!
  const winbackChips = [
    { label: 'All',                 count: WINBACK_FILTER_COUNTS.all, active: true },
    { label: 'Awaiting reply',      count: WINBACK_FILTER_COUNTS.awaiting },
    { label: 'High recovery',       count: WINBACK_FILTER_COUNTS.high },
    { label: 'Price cancellations', count: WINBACK_FILTER_COUNTS.price },
    { label: 'Recovered',           count: WINBACK_FILTER_COUNTS.recovered },
    { label: 'Done',                count: WINBACK_FILTER_COUNTS.done },
  ]

  return (
    <div className="bg-[#f5f5f5] rounded-2xl p-4 sm:p-6 border border-slate-200">
      {/* Two-column desktop layout: dashboard content on the left, drawer on the right.
          Drawer renders inline (not as a fixed overlay) so prospects see the rich
          per-subscriber detail without obscuring the table. Stacks below table on mobile. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_22rem] gap-4">
        {/* LEFT — dashboard */}
        <div>
          <TabStrip active="winback" />

          <PipelineStrip pipeline={WINBACK_PIPELINE} />

          {/* KPI cards — clean white cards on the page background (the legacy
              "needs your attention" handoff alert + blue-tint band were
              removed; the AI no longer escalates a queue). */}
          <section className="mb-7">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              <StatCard
                accent="blue"
                icon={<TrendingUp className="w-4 h-4" />}
                value={`${WINBACK_KPI.recoveryRate30d}%`}
                label="Recovery rate (30d)"
              />
              <StatCard
                accent="blue"
                icon={<CheckCircle className="w-4 h-4" />}
                value={String(WINBACK_KPI.recoveredLifetime)}
                label="Recovered · lifetime"
                delta={formatDelta(WINBACK_KPI.recoveredThisMonth, WINBACK_KPI.recoveredLastMonth, 'count')}
                sparkline={WINBACK_KPI.dailyRecovered}
              />
              <StatCard
                accent="blue"
                icon={<DollarSign className="w-4 h-4" />}
                value={fmtUsd(WINBACK_KPI.cumulativeRevenueCents)}
                subValue={`${fmtUsd(WINBACK_KPI.activeMrrCents)}/mo currently active`}
                label="Revenue saved · lifetime"
                delta={formatDelta(WINBACK_KPI.mrrThisMonthCents, WINBACK_KPI.mrrLastMonthCents, 'money')}
              />
              <StatCard
                accent="amber"
                icon={<Users className="w-4 h-4" />}
                value={String(WINBACK_KPI.inProgress)}
                label="In progress"
              />
            </div>
          </section>

          <PatternPills items={WINBACK_TOP_REASONS} />

          {/* Filter chips + search */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
            <FilterChips chips={winbackChips} />
            <DemoSearch placeholder="Search name, email, reason" />
          </div>

          {/* Subscriber table — avatar + "awaiting reply" dot/snippet +
              recovery-likelihood chip, mirroring the live dashboard. */}
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
                {WINBACK_ROWS.map((row) => {
                  const isSelected = row.id === WINBACK_SELECTED_ID
                  const isClosed = row.status === 'lost' || row.status === 'recovered' || row.status === 'skipped'
                  const initial = (row.name?.[0] ?? '?').toUpperCase()
                  const showSnippet = !!(row.awaitingReply && row.latestReplySnippet)
                  const snippet = (row.latestReplySnippet ?? '').slice(0, 80)
                  const avatarClass =
                    row.status === 'recovered' ? 'bg-emerald-50 text-emerald-700'
                    : row.recoveryLikelihood === 'high' ? 'bg-gradient-to-br from-amber-200 to-amber-300 text-amber-900'
                    : 'bg-slate-100 text-slate-500'
                  return (
                    <tr
                      key={row.id}
                      className={`hover:bg-slate-50/70 transition-colors ${isSelected ? 'bg-blue-50/40' : ''}`}
                    >
                      <td className="py-3.5 pl-3 pr-4">
                        <div className="flex items-center gap-2.5">
                          {/* Unread-style dot — "the ball's in your court". */}
                          <span className="w-2 flex justify-center shrink-0">
                            {showSnippet && <span className="w-2 h-2 rounded-full bg-amber-400" />}
                          </span>
                          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold shrink-0 ${avatarClass}`}>{initial}</div>
                          <div className="min-w-0">
                            <div className={`text-sm text-slate-900 leading-tight ${showSnippet ? 'font-bold' : 'font-medium'}`}>{row.name}</div>
                            {showSnippet ? (
                              <div className="text-xs text-amber-700 mt-0.5 truncate max-w-[200px]">
                                <MessageSquare className="w-3 h-3 inline-block align-[-2px] mr-1" />
                                “{snippet}”
                              </div>
                            ) : (
                              <div className="text-xs text-slate-400 mt-0.5 truncate max-w-[200px]">{row.email}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="hidden lg:table-cell text-sm text-slate-600 py-3.5 px-4">{row.planName}</td>
                      <td className="hidden sm:table-cell text-sm text-slate-500 py-3.5 px-4">{row.cancelledAt}</td>
                      <td className="hidden md:table-cell text-sm text-slate-600 py-3.5 px-4">
                        {row.cancellationReason.length > 45
                          ? row.cancellationReason.slice(0, 45) + '…'
                          : row.cancellationReason}
                      </td>
                      <td className="py-3.5 px-4">
                        {(() => {
                          if (isClosed) {
                            if (row.status === 'recovered') {
                              return <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">✓ Recovered</span>
                            }
                            const closedLabel = row.status === 'lost' ? 'Lost' : 'Skipped'
                            return <span className="inline-flex items-center text-[11px] font-medium text-slate-500 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-full">{closedLabel}</span>
                          }
                          const rl = row.recoveryLikelihood
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
                      <td className={`text-sm font-semibold tabular-nums py-3.5 pr-5 text-right ${row.status === 'recovered' ? 'text-emerald-700' : 'text-slate-900'}`}>
                        ${(row.mrrCents / 100).toFixed(2)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT — drawer (always-open in the demo). Block layout mirrors the
            live dashboard's redesigned panel: identity · AI insight ·
            conversation · reply composer · Details footer. The AI sends one
            listen-only exit email then stays quiet; the founder replies at
            any time from the composer (no take-over / handoff step). */}
        <aside className="bg-white rounded-2xl border border-slate-100 overflow-hidden lg:sticky lg:top-6 lg:self-start lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          {/* Block 1: identity — avatar + name + MRR + recovery chip */}
          <div className="px-5 pt-5 pb-4 flex items-start gap-3">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-amber-200 text-amber-900 text-sm font-semibold shrink-0">
              {selected.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <div className="text-base font-semibold text-slate-900 truncate">{selected.name}</div>
                  <div className="text-xs text-slate-500 truncate mt-0.5">{selected.email}</div>
                </div>
                <span className="w-7 h-7 -mr-1 -mt-1 rounded-full flex items-center justify-center text-slate-400 shrink-0">
                  <X className="w-3.5 h-3.5" />
                </span>
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="text-sm font-semibold text-slate-900 tabular-nums">
                  ${(selected.mrrCents / 100).toFixed(0)}<span className="text-xs text-slate-400 font-medium">/mo</span>
                </span>
                <span className="text-slate-300">·</span>
                <span className="inline-flex items-center text-[10px] uppercase tracking-wider font-semibold text-amber-900 bg-amber-100 border border-amber-200 px-2 py-0.5 rounded-full">
                  High recovery
                </span>
              </div>
            </div>
          </div>

          {/* Block 2: manual promo offer action */}
          <div className="px-5 py-3 border-t border-slate-100">
            <span className="w-full inline-flex items-center justify-center gap-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg py-2">
              <DollarSign className="w-4 h-4" />
              Send promo offer
            </span>
          </div>

          {/* Block 3: AI insight — Read + Worth knowing */}
          <div className="px-5 py-3 border-t border-slate-100">
            <div className="rounded-xl bg-violet-50 border border-violet-200/60 p-3.5 flex items-start gap-2.5">
              <div className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-violet-600 text-white text-[10px] font-bold shrink-0 mt-0.5">AI</div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-violet-700 mb-1">Insight</div>
                <div className="text-[13px] text-slate-800 leading-relaxed space-y-1">
                  <div><span className="text-violet-700 font-semibold">Read.</span> Price-sensitive, not gone to a competitor &mdash; $99/mo felt steep for a solo seat.</div>
                  <div><span className="text-violet-700 font-semibold">Worth knowing.</span> He asked directly whether a $49 plan is real. A straight answer likely converts.</div>
                </div>
              </div>
            </div>
          </div>

          {/* Block 4: conversation thread */}
          <div className="px-5 py-4 border-t border-slate-100">
            <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-3">
              Conversation <span className="ml-1.5 text-slate-400 normal-case tracking-normal">· 2 messages</span>
            </div>
            <ol className="space-y-2">
              <li className="border border-slate-200 rounded-xl bg-white">
                <div className="w-full flex items-start gap-3 p-3 text-left">
                  <span className="mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-900 text-white text-[10px] font-semibold shrink-0">AI</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">AI · sent on your behalf · winback_exit</span>
                      <span className="text-[10px] text-slate-400">Apr 29 · 9:12 AM</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">replied</span>
                    </div>
                    <div className="text-sm text-slate-800 truncate">A cheaper way to keep Aurora?</div>
                  </div>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 mt-1.5 shrink-0" />
                </div>
              </li>
              <li className="border border-indigo-200 bg-indigo-50/40 rounded-xl">
                <div className="w-full flex items-start gap-3 p-3 text-left">
                  <span className="mt-0.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-indigo-600 text-white text-[10px] font-semibold shrink-0">
                    {selected.name.charAt(0).toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-indigo-700 font-semibold">Them</span>
                      <span className="text-[10px] text-slate-400">May 1 · 2:03 PM</span>
                    </div>
                    <div className="text-sm text-slate-800 truncate">Yeah, $49 would change my mind. Is that a real plan or are you just feeling it out?</div>
                  </div>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-400 mt-1.5 shrink-0" />
                </div>
              </li>
            </ol>
          </div>

          {/* Block 5: reply composer — always available (no take-over step) */}
          <div className="px-5 py-4 border-t border-slate-100">
            <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold mb-2">Your reply</div>
            <div className="border border-slate-200 rounded-xl bg-white overflow-hidden">
              <div className="w-full px-3.5 pt-3 pb-2 text-[13px] text-slate-400 leading-relaxed min-h-[5.5rem]">Write your reply…</div>
              <div className="px-3.5 py-2 border-t border-slate-100 bg-slate-50/60 text-[10px] text-slate-500 flex items-center justify-between">
                <span className="truncate">↓ auto-appends reactivate · sign-off · unsubscribe</span>
                <span className="tabular-nums font-medium ml-2 shrink-0 text-slate-400">0 / 500</span>
              </div>
            </div>
            <div className="flex items-center justify-end mt-3">
              <span className="bg-slate-900 text-white rounded-full px-4 py-2 text-xs font-semibold flex items-center gap-1.5">
                Send reply <Send className="w-3 h-3" />
              </span>
            </div>
          </div>

          {/* Block 6: quiet footer with Details toggle */}
          <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between text-[11px]">
            <span className="text-slate-400">
              Cancelled Apr 28<span className="text-slate-300 mx-1.5">·</span>contacted
            </span>
            <span className="text-slate-500 font-medium flex items-center gap-1">
              Details <ChevronDown className="w-3 h-3" />
            </span>
          </div>
        </aside>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Payment-recovery demo dashboard
// ─────────────────────────────────────────────────────────────────────────

export function PaymentRecoveryDemoDashboard() {
  const expanded = PAYMENT_ROWS.find((r) => r.id === PAYMENT_EXPANDED_ID)!
  const paymentChips = [
    { label: 'All',          count: PAYMENT_FILTER_COUNTS.all,        active: true },
    { label: 'In retry',     count: PAYMENT_FILTER_COUNTS.inRetry },
    { label: 'Final retry',  count: PAYMENT_FILTER_COUNTS.finalRetry },
    { label: 'Recovered',    count: PAYMENT_FILTER_COUNTS.recovered },
    { label: 'Lost',         count: PAYMENT_FILTER_COUNTS.lost },
  ]

  return (
    <div className="bg-[#f5f5f5] rounded-2xl p-4 sm:p-6 border border-slate-200">
      <TabStrip active="paymentRecovery" />

      <PipelineStrip pipeline={PAYMENT_PIPELINE} />

      {/* KPI band — green tint */}
      <section className="rounded-3xl bg-green-100 border border-green-200 p-3 mb-7">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          <StatCard
            accent="green"
            icon={<TrendingUp className="w-4 h-4" />}
            value={`${PAYMENT_KPI.recoveryRate30d}%`}
            label="Recovery rate (30d)"
          />
          <StatCard
            accent="green"
            icon={<CheckCircle className="w-4 h-4" />}
            value={String(PAYMENT_KPI.recoveredLifetime)}
            label="Recovered · lifetime"
            delta={formatDelta(PAYMENT_KPI.recoveredThisMonth, PAYMENT_KPI.recoveredLastMonth, 'count')}
            sparkline={PAYMENT_KPI.dailyRecovered}
          />
          <StatCard
            accent="green"
            icon={<DollarSign className="w-4 h-4" />}
            value={fmtUsd(PAYMENT_KPI.cumulativeRevenueCents)}
            subValue={`${fmtUsd(PAYMENT_KPI.activeMrrCents)}/mo currently active`}
            label="Revenue saved · lifetime"
            delta={formatDelta(PAYMENT_KPI.mrrThisMonthCents, PAYMENT_KPI.mrrLastMonthCents, 'money')}
          />
          <StatCard
            accent="amber"
            icon={<Users className="w-4 h-4" />}
            value={String(PAYMENT_KPI.inDunning)}
            label="In dunning"
          />
        </div>
      </section>

      <PatternPills items={PAYMENT_TOP_DECLINES} />

      {/* Filter chips + search */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
        <FilterChips chips={paymentChips} />
        <DemoSearch placeholder="Search name, email, decline code" />
      </div>

      {/* Subscriber table — payment-recovery uses in-place expansion */}
      <div className="bg-white rounded-2xl border border-slate-100 overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Subscriber</th>
              <th className="hidden sm:table-cell text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Failed at</th>
              <th className="hidden md:table-cell text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Decline</th>
              <th className="text-left text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">Stage</th>
              <th className="text-right text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 px-4">MRR</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {PAYMENT_ROWS.map((row) => {
              const isExpanded = row.id === PAYMENT_EXPANDED_ID
              return (
                <Fragment key={row.id}>
                  <tr
                    className={`border-b border-slate-50 transition-colors ${isExpanded ? 'bg-rose-50/30' : ''}`}
                  >
                    <td className="py-4 pr-4 px-4">
                      <div className="text-sm font-medium text-slate-900">{row.name}</div>
                      <div className="text-xs text-slate-400 mt-0.5 truncate max-w-[160px] sm:max-w-none">{row.email}</div>
                    </td>
                    <td className="hidden sm:table-cell text-sm text-slate-600 py-4 px-4 tabular-nums">{row.failedAt}</td>
                    <td className="hidden md:table-cell text-sm text-slate-600 py-4 px-4 font-mono text-xs">{row.declineCode}</td>
                    <td className="py-4 px-4"><DunningStageBadge row={row} /></td>
                    <td className="text-sm font-medium text-slate-900 py-4 px-4 text-right tabular-nums">
                      ${(row.mrrCents / 100).toFixed(0)}
                    </td>
                    <td className="text-slate-400 py-4 px-2 text-right">
                      <span className={`inline-block transition-transform ${isExpanded ? 'rotate-90' : ''}`}>›</span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-slate-50/60 border-b border-slate-100">
                      <td colSpan={6} className="px-4 py-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Dunning state</div>
                            <div className="text-slate-700">final_retry_pending</div>
                            <div className="text-xs text-slate-500 mt-1">T3 sent on 2026-04-28</div>
                            <div className="text-xs text-slate-500 mt-1">Next Stripe retry: 2026-05-04</div>
                          </div>
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1">Last decline</div>
                            <div className="text-slate-700 font-mono text-xs">insufficient_funds</div>
                            <div className="text-xs text-slate-500 mt-1 italic">
                              &ldquo;Card was declined for insufficient funds. Bank: Chase.&rdquo;
                            </div>
                          </div>
                        </div>
                        <div className="mt-4">
                          <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 mb-2">Email touches</div>
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200">T1 sent · 2026-04-25</span>
                            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200">T2 sent · 2026-04-27</span>
                            <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 bg-rose-50 text-rose-700 border border-rose-200">T3 sent · 2026-04-28</span>
                          </div>
                        </div>
                        <div className="mt-4">
                          <span className="inline-flex items-center bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium">
                            Resend update-payment email
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

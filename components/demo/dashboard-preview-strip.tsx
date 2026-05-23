/**
 * Cropped dashboard previews embedded on marketing pages. Mirrors the
 * real /dashboard at every level — pipeline, KPIs, reasons strip,
 * filter chips, subscriber rows. The full uncropped versions live at
 * /demo/win-back and /demo/payment-recovery.
 *
 * What's shared with the real dashboard:
 *   - PipelineStrip + StatCard primitives (imported from demo-dashboard)
 *   - PatternPills row + recovery-likelihood chip + amber awaiting-reply
 *     dot — same Tailwind classes, same color tokens
 *
 * What's intentionally NOT here (kept off marketing pages):
 *   - The drawer (real dashboard opens it only on row click; demo is a
 *     static preview, no interaction)
 *   - The first-recovery celebration banner (billing-state surface)
 */

import Link from 'next/link'
import { TrendingUp, CheckCircle, DollarSign, Users } from 'lucide-react'
import {
  PipelineStrip,
  StatCard,
  formatDelta,
  fmtUsd,
  WINBACK_PIPELINE,
  WINBACK_KPI,
  PAYMENT_PIPELINE,
  PAYMENT_KPI,
} from './demo-dashboard'

interface PreviewWrapperProps {
  /** "blue" for win-back, "green" for payment recovery — matches the cohort tint on the full demo. */
  accent: 'blue' | 'green'
  /** Title shown above the preview, e.g. "Win-backs" / "Payment recoveries". */
  title: string
  /** Where the "Explore the dashboard →" link goes. */
  href: string
  /** Children render the KPI grid + pipeline strip. */
  children: React.ReactNode
}

function PreviewWrapper({ accent, title, href, children }: PreviewWrapperProps) {
  const tintClass = accent === 'blue' ? 'bg-blue-50' : 'bg-emerald-50'
  const accentText = accent === 'blue' ? 'text-blue-700' : 'text-emerald-700'
  return (
    <div className={`rounded-3xl ${tintClass} p-4 sm:p-5 border border-slate-100`}>
      <div className="flex items-center justify-between gap-3 mb-3 px-1">
        <div className={`text-xs font-semibold uppercase tracking-widest ${accentText}`}>
          {title}
        </div>
        <Link
          href={href}
          className={`text-xs font-medium ${accentText} hover:underline`}
        >
          Explore the dashboard →
        </Link>
      </div>
      {children}
    </div>
  )
}

// Top reasons strip — same labels + colors as the real dashboard, just
// preview percentages.
const WINBACK_PREVIEW_TOP_REASONS = [
  { label: 'Price',    pct: 32 },
  { label: 'Other',    pct: 26 },
  { label: 'Feature',  pct: 24 },
  { label: 'Switched', pct: 18 },
]

/**
 * Win-back cohort preview — pipeline + KPI band + top reasons. Marketing
 * teaser only; filter chips + subscriber table live on /demo/win-back
 * (linked via "Explore the dashboard →").
 */
export function WinBackPreviewStrip() {
  return (
    <PreviewWrapper accent="blue" title="Cancellation winbacks" href="/demo/win-back">
      <div className="bg-white rounded-2xl p-3 sm:p-4 space-y-4">
        <PipelineStrip pipeline={WINBACK_PIPELINE} />

        {/* KPI band */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
            delta={formatDelta(
              WINBACK_KPI.recoveredThisMonth,
              WINBACK_KPI.recoveredLastMonth,
              'count',
            )}
            sparkline={WINBACK_KPI.dailyRecovered}
          />
          <StatCard
            accent="blue"
            icon={<DollarSign className="w-4 h-4" />}
            value={fmtUsd(WINBACK_KPI.cumulativeRevenueCents)}
            subValue={`${fmtUsd(WINBACK_KPI.activeMrrCents)}/mo currently active`}
            label="Revenue saved · lifetime"
          />
          <StatCard
            accent="amber"
            icon={<Users className="w-4 h-4" />}
            value={String(WINBACK_KPI.inProgress)}
            label="In progress"
          />
        </div>

        {/* Top reasons strip */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {WINBACK_PREVIEW_TOP_REASONS.map((r) => (
            <span
              key={r.label}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${themeColor(r.label)}`}
            >
              {r.label}
              <span className="text-[10px] tabular-nums opacity-70">{r.pct}%</span>
            </span>
          ))}
        </div>
      </div>
    </PreviewWrapper>
  )
}

/**
 * Payment-recovery cohort preview — thin, just the dunning KPIs. The
 * flow is simpler than win-back and doesn't need the deeper narrative
 * on the home page; the full detail lives at /demo/payment-recovery.
 */
export function PaymentRecoveryPreviewStrip() {
  return (
    <PreviewWrapper accent="green" title="Payment recoveries" href="/demo/payment-recovery">
      <div className="bg-white rounded-2xl p-3 sm:p-4">
        <PipelineStrip pipeline={PAYMENT_PIPELINE} />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
            delta={formatDelta(
              PAYMENT_KPI.recoveredThisMonth,
              PAYMENT_KPI.recoveredLastMonth,
              'count',
            )}
            sparkline={PAYMENT_KPI.dailyRecovered}
          />
          <StatCard
            accent="green"
            icon={<DollarSign className="w-4 h-4" />}
            value={fmtUsd(PAYMENT_KPI.cumulativeRevenueCents)}
            subValue={`${fmtUsd(PAYMENT_KPI.activeMrrCents)}/mo currently active`}
            label="Revenue saved · lifetime"
          />
          <StatCard
            accent="amber"
            icon={<Users className="w-4 h-4" />}
            value={String(PAYMENT_KPI.inDunning)}
            label="In dunning"
          />
        </div>
      </div>
    </PreviewWrapper>
  )
}

function themeColor(label: string): string {
  switch (label) {
    case 'Price':    return 'bg-rose-50 text-rose-700'
    case 'Feature':  return 'bg-blue-50 text-blue-700'
    case 'Quality':  return 'bg-amber-50 text-amber-700'
    case 'Switched': return 'bg-violet-50 text-violet-700'
    case 'Other':    return 'bg-slate-100 text-slate-600'
    default:         return 'bg-slate-100 text-slate-700'
  }
}

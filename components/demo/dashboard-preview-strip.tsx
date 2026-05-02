/**
 * Cropped dashboard preview — pipeline strip + KPI band only — designed
 * to embed on marketing pages. Same visual primitives as the full demo
 * dashboard at /demo/{cohort} (which is what the "See live demo →" CTA
 * links to), but stripped to the headline-bearing portion so it fits in
 * the marketing pages' max-w-5xl story rhythm.
 *
 * Two cohort exports + a CTA-link helper. No interactivity (server-
 * component-safe). Reuses the data + primitives exported from
 * components/demo/demo-dashboard.tsx — no duplication.
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
  /** Where the "See live demo →" link goes. */
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
          See live demo →
        </Link>
      </div>
      {children}
    </div>
  )
}

/**
 * Win-back cohort preview — pipeline strip on top, 4-card KPI band below.
 * Tinted blue (matches the full demo's win-back tab color).
 */
export function WinBackPreviewStrip() {
  return (
    <PreviewWrapper accent="blue" title="Win-backs" href="/demo/win-back">
      <div className="bg-white rounded-2xl p-3 sm:p-4">
        <PipelineStrip pipeline={WINBACK_PIPELINE} />
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
      </div>
    </PreviewWrapper>
  )
}

/**
 * Payment-recovery cohort preview — same shape, green tint.
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

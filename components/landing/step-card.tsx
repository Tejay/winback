import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type Tint = 'amber' | 'blue' | 'emerald'

const TINTS: Record<Tint, { badge: string; iconColor: string; label: string }> = {
  amber:   { badge: 'bg-amber-100',   iconColor: 'text-orange-500',  label: 'text-orange-500' },
  blue:    { badge: 'bg-sky-100',     iconColor: 'text-sky-600',     label: 'text-sky-600' },
  emerald: { badge: 'bg-emerald-100', iconColor: 'text-emerald-600', label: 'text-emerald-600' },
}

interface StepCardProps {
  step: string
  label: string
  title: string
  body: string
  icon: LucideIcon
  tint: Tint
  /**
   * Longer explainer revealed when the user clicks the card. Uses the
   * native <details>/<summary> pattern — no client JS, keyboard-accessible
   * by default. Optional: if omitted, the card is non-expanding.
   */
  details?: ReactNode
}

export function StepCard({
  step,
  label,
  title,
  body,
  icon: Icon,
  tint,
  details,
}: StepCardProps) {
  const { badge, iconColor, label: labelColor } = TINTS[tint]

  const head = (
    <>
      <div
        className={`w-14 h-14 rounded-2xl ${badge} flex items-center justify-center`}
        aria-hidden
      >
        <Icon className={`w-7 h-7 ${iconColor}`} strokeWidth={2.25} />
      </div>
      <div
        className={`mt-6 text-xs font-semibold uppercase tracking-[0.18em] ${labelColor}`}
      >
        {step} &mdash; {label}
      </div>
      <h3 className="text-2xl font-bold text-slate-900 mt-3 leading-tight">
        {title}
      </h3>
      <p className="text-sm text-slate-500 mt-4 leading-relaxed">{body}</p>
    </>
  )

  if (!details) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-7">
        {head}
      </div>
    )
  }

  return (
    <details className="group bg-white rounded-2xl shadow-sm border border-slate-100 p-7 transition-shadow open:shadow-md">
      <summary className="list-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-xl">
        {head}
        <div className="mt-5 inline-flex items-center gap-1 text-xs font-medium text-slate-400 group-hover:text-slate-600 group-open:text-slate-600">
          <span className="group-open:hidden">Read more</span>
          <span className="hidden group-open:inline">Show less</span>
          <span className="transition-transform group-open:rotate-180" aria-hidden>
            ▾
          </span>
        </div>
      </summary>
      <div className="mt-5 pt-5 border-t border-slate-100 text-sm text-slate-600 leading-relaxed space-y-3">
        {details}
      </div>
    </details>
  )
}

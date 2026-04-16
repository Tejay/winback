import { Brain, XCircle, TrendingUp } from 'lucide-react'

/**
 * Hero flow metaphor: cancellation → AI → recovery. Three nodes connected
 * by dashed SVG arrows that animate once on mount (CSS-only, no JS state).
 *
 * The middle (AI) node pulses via Tailwind's `animate-pulse` on a glow ring
 * so the user's eye lands on the differentiator. Everything else is static.
 */
export function FlowIllustration() {
  return (
    <div className="w-full max-w-xl mx-auto mt-12">
      <style>{`
        @keyframes flow-dash {
          from { stroke-dashoffset: 24; }
          to   { stroke-dashoffset: 0; }
        }
        .flow-arrow {
          stroke-dasharray: 6 6;
          animation: flow-dash 1.2s ease-out both;
        }
      `}</style>

      <div className="flex items-center justify-between gap-2 sm:gap-3">
        {/* Cancellation */}
        <div className="flex-1 bg-white rounded-xl border border-slate-200 shadow-sm px-3 py-3 text-center">
          <div className="mx-auto w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center">
            <XCircle className="w-4 h-4 text-slate-500" aria-hidden />
          </div>
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-widest text-slate-400">
            Cancelled
          </div>
          <div className="text-xs font-medium text-slate-700 mt-0.5">
            £24.99/mo
          </div>
        </div>

        {/* Arrow 1 */}
        <Arrow />

        {/* AI node */}
        <div className="flex-1 relative">
          <div className="absolute inset-0 rounded-xl bg-violet-200/60 blur-xl animate-pulse" aria-hidden />
          <div className="relative bg-white rounded-xl border border-violet-200 shadow-sm px-3 py-3 text-center">
            <div className="mx-auto w-8 h-8 rounded-lg bg-violet-50 flex items-center justify-center">
              <Brain className="w-4 h-4 text-violet-600" aria-hidden />
            </div>
            <div className="mt-2 text-[11px] font-semibold uppercase tracking-widest text-violet-600">
              AI tuned
            </div>
            <div className="text-xs font-medium text-slate-700 mt-0.5">
              Personalised reply
            </div>
          </div>
        </div>

        {/* Arrow 2 */}
        <Arrow />

        {/* Recovery */}
        <div className="flex-1 bg-white rounded-xl border border-emerald-200 shadow-sm px-3 py-3 text-center">
          <div className="mx-auto w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
            <TrendingUp className="w-4 h-4 text-emerald-600" aria-hidden />
          </div>
          <div className="mt-2 text-[11px] font-semibold uppercase tracking-widest text-emerald-600">
            Recovered
          </div>
          <div className="text-xs font-medium text-slate-700 mt-0.5">
            +£24.99/mo
          </div>
        </div>
      </div>
    </div>
  )
}

function Arrow() {
  return (
    <svg
      viewBox="0 0 40 16"
      className="w-6 sm:w-10 h-4 text-slate-300 flex-shrink-0"
      fill="none"
      aria-hidden
    >
      <path
        className="flow-arrow"
        d="M2 8 H32"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M30 3 L36 8 L30 13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

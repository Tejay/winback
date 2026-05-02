import { Clock, Mail, Wallet } from 'lucide-react'

/**
 * Payment-recovery hero flow — mirrors the structure of
 * components/landing/flow-illustration.tsx (used on the landing + win-back
 * pages) so prospects feel the visual continuity across the two product
 * pages. Three claim-cards connected by dashed SVG arrows.
 *
 * Where the win-back version is a temporal story (Cancelled → AI → Recovered),
 * this one is the three product claims as a "what we do" flow:
 * Lead Stripe's retries → Tell them what's wrong → One tap to fix.
 *
 * The middle (email) node pulses via animate-pulse so the eye lands on
 * the differentiator (the decline-aware nudge — that's the part Stripe
 * doesn't do for you).
 *
 * Replaces the standalone Pillars section — the same three claims now
 * live in the hero, so the page doesn't say them twice.
 */
export function PaymentFlowIllustration() {
  return (
    <div className="w-full max-w-3xl mx-auto mt-12">
      <style>{`
        @keyframes flow-dash-pr {
          from { stroke-dashoffset: 24; }
          to   { stroke-dashoffset: 0; }
        }
        .flow-arrow-pr {
          stroke-dasharray: 6 6;
          animation: flow-dash-pr 1.2s ease-out both;
        }
      `}</style>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 sm:gap-2">
        {/* Lead Stripe's retries */}
        <div className="flex-1 bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-4 text-center min-h-[110px] flex flex-col items-center justify-center">
          <div className="mx-auto w-9 h-9 rounded-lg bg-slate-100 flex items-center justify-center">
            <Clock className="w-5 h-5 text-slate-600" aria-hidden />
          </div>
          <div className="mt-3 text-sm font-semibold text-slate-900 leading-snug">
            Lead Stripe&rsquo;s retries.
          </div>
        </div>

        <Arrow />

        {/* Tell them what's wrong — the differentiator (pulses) */}
        <div className="flex-1 relative">
          <div className="absolute inset-0 rounded-xl bg-blue-200/60 blur-xl animate-pulse" aria-hidden />
          <div className="relative bg-white rounded-xl border border-blue-200 shadow-sm px-4 py-4 text-center min-h-[110px] flex flex-col items-center justify-center">
            <div className="mx-auto w-9 h-9 rounded-lg bg-blue-50 flex items-center justify-center">
              <Mail className="w-5 h-5 text-blue-600" aria-hidden />
            </div>
            <div className="mt-3 text-sm font-semibold text-slate-900 leading-snug">
              Tell them what&rsquo;s actually wrong.
            </div>
          </div>
        </div>

        <Arrow />

        {/* One tap to fix */}
        <div className="flex-1 bg-white rounded-xl border border-emerald-200 shadow-sm px-4 py-4 text-center min-h-[110px] flex flex-col items-center justify-center">
          <div className="mx-auto w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center">
            <Wallet className="w-5 h-5 text-emerald-600" aria-hidden />
          </div>
          <div className="mt-3 text-sm font-semibold text-slate-900 leading-snug">
            One tap to fix the card.
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
      className="hidden sm:block w-6 sm:w-10 h-4 text-slate-300 flex-shrink-0"
      fill="none"
      aria-hidden
    >
      <path
        className="flow-arrow-pr"
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

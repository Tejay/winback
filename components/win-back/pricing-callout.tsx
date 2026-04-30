import Link from 'next/link'
import { Check } from 'lucide-react'

/**
 * /win-back pricing callout. Mirrors components/payment-recovery/pricing-callout.tsx
 * structurally, but the headline numbers + included list pivot to the
 * 1× MRR performance-fee story.
 */

const INCLUDED = [
  { lead: 'AI-drafted email',          rest: 'per cancellation, never templated' },
  { lead: 'Refundable for 14 days',    rest: 'if the customer re-cancels' },
  { lead: 'Re-engages on changelog',   rest: 'when you ship what they wanted' },
  { lead: '$0 if we don’t recover',    rest: 'any cancelled subscribers that month' },
]

export function PricingCallout() {
  return (
    <section className="bg-white py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-5xl mx-auto px-6">
        <div
          className="bg-[#0f172a] text-white rounded-3xl p-10 sm:p-16 overflow-hidden relative"
          style={{
            backgroundImage:
              'radial-gradient(circle at 1px 1px, rgba(15, 23, 42, 0.06) 1px, transparent 0)',
            backgroundSize: '24px 24px',
          }}
        >
          <div className="relative max-w-4xl mx-auto">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-400 text-center">
            Pricing
          </p>

          {/* Big stat — 1× MRR per win-back */}
          <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-8">
            <div className="text-center">
              <p className="text-6xl sm:text-7xl font-bold tracking-tight leading-none text-blue-400">
                1×<span className="text-2xl text-slate-400 font-normal ml-2">MRR</span>
              </p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-slate-300">
                per recovered customer
              </p>
            </div>
            <div className="text-3xl sm:text-4xl text-slate-500 font-light hidden sm:block">·</div>
            <div className="text-center">
              <p className="text-5xl sm:text-6xl font-bold tracking-tight leading-none">14d</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-slate-300">
                refund window
              </p>
            </div>
          </div>

          <h2 className="mt-10 text-3xl sm:text-4xl font-bold tracking-tight text-center">
            You only pay when we win them back.
            <br className="hidden sm:block" />
            <span className="text-blue-400">Refundable if they re-cancel within 14 days.</span>
          </h2>

          <p className="mt-5 text-base text-slate-300 max-w-2xl mx-auto text-center">
            Charged once per recovered customer at their old MRR. If they cancel again within 14 days, we refund in full — no questions, no clawback paperwork. <span className="text-white font-semibold">Zero performance fee in months when we don&apos;t recover anyone.</span>
          </p>

          <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl mx-auto text-sm">
            {INCLUDED.map((row) => (
              <div
                key={row.lead}
                className="flex items-start gap-3 bg-white/5 border border-white/10 rounded-xl p-4"
              >
                <Check className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" strokeWidth={2} />
                <span className="text-slate-200">
                  <span className="text-white font-medium">{row.lead}</span> {row.rest}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-10 max-w-xl mx-auto text-center">
            <p className="text-sm text-slate-300 leading-relaxed">
              Worked example: at <span className="text-white font-semibold">$25 MRR</span>, three recovered customers in a month is <span className="text-white font-semibold">$75</span> in performance fees — and <span className="text-white font-semibold">$900 of MRR kept</span> over the next 12 months.
            </p>
          </div>

          <p className="mt-6 text-xs text-slate-500 text-center">
            Bundled with the <Link href="/payment-recovery" className="underline text-slate-300 hover:text-white">$99/mo platform fee</Link> — both flows together, one bill.
          </p>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/register"
              className="inline-flex items-center px-7 py-3.5 bg-white text-[#0f172a] rounded-full text-sm font-semibold hover:bg-slate-100 transition shadow-lg shadow-blue-500/10"
            >
              Connect Stripe in 60 seconds
            </Link>
            <Link
              href="#how-it-works"
              className="inline-flex items-center px-7 py-3.5 border border-slate-700 text-white rounded-full text-sm font-medium hover:bg-slate-800 transition"
            >
              See how it works
            </Link>
          </div>
          <p className="mt-6 text-xs text-slate-500 text-center">
            No card required to sign up. Billing starts on the first delivered save or win-back.
          </p>
        </div>
      </div>
      </div>
    </section>
  )
}

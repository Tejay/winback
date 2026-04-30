import Link from 'next/link'
import { Check } from 'lucide-react'

/**
 * Section 6 — dark pricing block. Source: marketing/payment-recovery-section.html §6.
 * "Up to 500 recoveries / mo · Included in your platform fee."
 * No "unlimited" or "∞" anywhere (Spec 34 user instruction).
 */

const INCLUDED = [
  { lead: 'Three payment-failure emails',  rest: '(T1, T2, T3) per recovery' },
  { lead: 'Apple Pay / Google Pay / Link', rest: 'on the update flow' },
  { lead: 'Recovered customers',           rest: '— keep 100% of the MRR' },
  { lead: 'Decline-aware copy',            rest: '+ merchant-branded landing' },
]

export function PricingCallout() {
  return (
    <section className="bg-[#f5f5f5] py-20 sm:py-24">
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

          {/* Big stat hero */}
          <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-8">
            <div className="text-center">
              <p className="text-6xl sm:text-7xl font-bold tracking-tight leading-none">
                $99<span className="text-2xl text-slate-400 font-normal">/mo</span>
              </p>
            </div>
            <div className="text-3xl sm:text-4xl text-slate-500 font-light hidden sm:block">·</div>
            <div className="text-center">
              <p className="text-5xl sm:text-6xl font-bold tracking-tight leading-none text-blue-400">500</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-slate-300">
                recoveries / mo
              </p>
            </div>
          </div>

          <h2 className="mt-10 text-3xl sm:text-4xl font-bold tracking-tight text-center">
            Up to 500 card-save recoveries every month.
            <br className="hidden sm:block" />
            <span className="text-blue-400">Included in your platform fee.</span>
          </h2>

          <p className="mt-5 text-base text-slate-300 max-w-2xl mx-auto text-center">
            No per-recovery cut. The cap is generous — most pilots use a fraction. Cards fail, we recover them, you keep <span className="text-white font-semibold">100% of the MRR</span>.
          </p>

          {/* What's included grid */}
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

          {/* Payback math */}
          <div className="mt-10 max-w-xl mx-auto text-center">
            <p className="text-sm text-slate-300 leading-relaxed">
              Save <span className="text-white font-semibold">one</span> $99/mo customer, the platform fee is paid for that month.
              <br className="hidden sm:block" />
              Save <span className="text-white font-semibold">two</span>, you&apos;re profitable by lunch.
            </p>
          </div>

          <p className="mt-6 text-xs text-slate-500 text-center">
            Most recovery tools charge per save or take a percentage of recovered revenue.{' '}
            <span className="text-slate-400">We don&apos;t.</span>
          </p>

          {/* CTA */}
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
            No card required to sign up. Billing starts on the first delivered save.
          </p>
        </div>
      </div>
      </div>
    </section>
  )
}

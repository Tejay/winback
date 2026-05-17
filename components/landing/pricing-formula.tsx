import Link from 'next/link'
import { Check } from 'lucide-react'

/**
 * Pricing — three colored-rail cards, one per fee line, so the
 * structure is impossible to misread.
 *
 * Reads as one design system with /payment-recovery, /win-back, and
 * the two-pillar teaser above:
 *   • Platform fee  → slate rail (the flat baseline)
 *   • Payment recovery → blue rail (bundled free)
 *   • Win-back fee  → emerald rail (pay-on-success)
 *
 * Copy notes:
 *   - "1× Monthly fee" instead of "MRR" (user feedback: MRR jargon
 *     isn't universally understood).
 *   - Headline names the differentiator directly: $99/mo flat, pay
 *     extra only when we win back a customer.
 *   - Sub-cards trust strip + fixed-contract escape hatch retained
 *     for the buyers who need them (procurement, annual contracts).
 */
export function PricingFormula() {
  return (
    <section id="pricing" className="bg-white py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-5xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center max-w-3xl mx-auto">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
            Pricing
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
            $99/mo flat. Pay extra only when we win back a customer.
          </h2>
          <p className="mt-4 text-sm sm:text-base text-slate-600">
            Payment recoveries are bundled into the platform fee. The performance fee only kicks in when we save you a cancelled customer.
          </p>
        </div>

        {/* Three pricing cards — same colored-rail design language as
            the two-pillar teaser so the page reads as one system. */}
        <div className="mt-12 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Card 1 — Platform fee (slate, flat baseline) */}
          <div
            className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-slate-400"
            style={{ backgroundImage: 'linear-gradient(to right, #f8fafc 0%, #ffffff 30%)' }}
          >
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
              Platform fee
            </p>
            <div className="mt-3 flex items-baseline gap-1.5">
              <span className="text-4xl font-bold text-slate-900 leading-none tabular-nums">$99</span>
              <span className="text-sm text-slate-500">/ month</span>
            </div>
            <p className="mt-3 text-sm text-slate-600 leading-relaxed">
              Flat. Both flows running. Cancel anytime.
            </p>
          </div>

          {/* Card 2 — Payment recovery (blue, included free) */}
          <div
            className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-blue-600"
            style={{ backgroundImage: 'linear-gradient(to right, #eff6ff 0%, #ffffff 30%)' }}
          >
            <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-700">
              Payment recovery
            </p>
            <div className="mt-3 flex items-baseline gap-1.5">
              <span className="text-4xl font-bold text-slate-900 leading-none">Free</span>
              <span className="text-sm text-slate-500">included</span>
            </div>
            <p className="mt-3 text-sm text-slate-600 leading-relaxed">
              Up to <strong className="text-slate-800">500 recoveries / mo</strong> bundled into the platform fee.
            </p>
          </div>

          {/* Card 3 — Win-back performance fee (emerald, pay-on-success) */}
          <div
            className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-emerald-600"
            style={{ backgroundImage: 'linear-gradient(to right, #ecfdf5 0%, #ffffff 30%)' }}
          >
            <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700">
              Win-back fee
            </p>
            <div className="mt-3 flex items-baseline gap-1.5">
              <span className="text-4xl font-bold text-slate-900 leading-none">1&times; Monthly fee</span>
            </div>
            <p className="mt-3 text-sm text-slate-600 leading-relaxed">
              Per cancelled customer we bring back.{' '}
              <strong className="text-slate-800">$0</strong>
              {' '}if we don&rsquo;t deliver any.
            </p>
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-slate-500">
          14-day money-back.{' '}
          <Link href="/pricing" className="text-blue-600 hover:underline">
            See full pricing &rarr;
          </Link>
        </p>

        {/* Trust strip — retained for buyers scanning for procurement
            checkboxes (cancel anytime, no setup, refund window). */}
        <div className="mt-12 max-w-3xl mx-auto">
          <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" strokeWidth={2.4} />
              <span>Free until first recovery or win-back</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" strokeWidth={2.4} />
              <span>14-day refund if they re-cancel</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" strokeWidth={2.4} />
              <span>Cancel anytime</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" strokeWidth={2.4} />
              <span>No setup fees</span>
            </div>
          </div>
        </div>

        {/* Fixed-contract alternative — kept verbatim for annual-budget
            buyers who can't operate on performance pricing. */}
        <div className="mt-12 max-w-xl mx-auto pt-10 border-t border-slate-200 text-center">
          <h3 className="text-sm font-semibold text-slate-900">
            Need a fixed annual contract?
          </h3>
          <p className="mt-3 text-sm text-slate-500 leading-relaxed">
            For teams that need predictable budgeting with SSO and a signed
            SLA &mdash; we offer fixed annual contracts as an alternative to
            the performance model.
          </p>
          <a
            href="mailto:sales@winbackflow.co"
            className="mt-4 inline-block text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            sales@winbackflow.co &rarr;
          </a>
        </div>
      </div>
    </section>
  )
}

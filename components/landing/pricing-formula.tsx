import Link from 'next/link'
import { Check } from 'lucide-react'

/**
 * Reframed pricing block — "$99 + 1× MRR" formula with two-column breakdown
 * and a worked example. Source: marketing/home-changes-mockup.html Change #2.
 *
 * Replaces the legacy two-fee table on home (app/page.tsx:223-490 in the
 * pre-reorg version). Same numbers, different framing: one bill with two
 * triggers, not two products to pick between.
 */
export function PricingFormula() {
  return (
    <section id="pricing" className="bg-[#f5f5f5] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6">
        <div className="text-center mb-10">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">Pricing</p>
        <h2 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
          One bill. Two triggers.
        </h2>
        <p className="mt-4 text-sm text-slate-600 max-w-2xl mx-auto">
          Not an à la carte menu. Both flows are the same product — you just see different line items depending on what we recovered for you that month.
        </p>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">

        {/* Header strip */}
        <div className="bg-slate-50 border-b border-slate-200 px-7 py-4 flex items-center justify-between">
          <p className="text-sm font-semibold text-slate-900">Your monthly bill</p>
          <p className="text-xs text-slate-500">Billed at end of month</p>
        </div>

        {/* Math expression */}
        <div className="px-7 py-10 sm:py-12">
          <div className="flex flex-col sm:flex-row items-center justify-center gap-5 sm:gap-8">
            <div className="text-center">
              <p className="text-5xl sm:text-6xl font-bold tracking-tight text-slate-900 leading-none">$99</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-slate-500">Always</p>
            </div>
            <div className="text-3xl sm:text-4xl text-slate-400 font-light">+</div>
            <div className="text-center">
              <p className="text-5xl sm:text-6xl font-bold tracking-tight text-blue-600 leading-none">1×&nbsp;MRR</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-slate-500">Only on win-back recoveries</p>
            </div>
          </div>

          {/* Two-column breakdown */}
          <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-slate-100">
            <div className="px-2 sm:pr-8 pb-6 sm:pb-0">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-blue-600">Platform fee</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">$99 / month, always</p>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Up to 500 payment-recovery saves / month</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Three-touch email sequence per failure</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Apple Pay / Google Pay / Link update flow</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>AI classifier + win-back drafts (always running)</span>
                </li>
              </ul>
            </div>

            <div className="px-2 sm:pl-8 pt-6 sm:pt-0">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-blue-600">Performance fee</p>
              <p className="mt-1 text-sm font-semibold text-slate-900">1× MRR — only when we recover a deliberate cancel</p>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Charged per recovered customer, once</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Refundable in full for 14 days if they re-cancel</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span className="text-slate-900 font-semibold">$0 if we don&apos;t recover any</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Payment-recovery saves are <span className="font-medium">free</span> (covered by platform fee)</span>
                </li>
              </ul>
            </div>
          </div>

          {/* Worked example */}
          <div className="mt-10 bg-slate-50 border border-slate-200 rounded-2xl px-6 py-5 max-w-2xl mx-auto">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 mb-2">Worked example</p>
            <p className="text-sm text-slate-700 leading-relaxed">
              A merchant with a typical month: <span className="text-slate-900 font-medium">8 payment failures</span> recovered (free under platform fee), <span className="text-slate-900 font-medium">2 voluntary cancels</span> won back at $79/mo MRR each.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-xs text-slate-500">Platform</p>
                <p className="text-lg font-semibold text-slate-900">$99</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Performance (2 × $79)</p>
                <p className="text-lg font-semibold text-slate-900">$158</p>
              </div>
              <div className="border-l border-slate-200 pl-3">
                <p className="text-xs text-slate-500">Total bill</p>
                <p className="text-lg font-bold text-blue-600">$257</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              They kept ~<span className="text-slate-900 font-semibold">$1,150 of MRR</span> that would have walked. Net positive on day one.
            </p>
          </div>
        </div>

        <div className="bg-slate-50 border-t border-slate-200 px-7 py-6 flex flex-wrap items-center justify-between gap-4">
          <p className="text-sm text-slate-600">
            <span className="text-slate-900 font-medium">No card required to sign up.</span>{' '}
            Billing starts on the first delivered save.
          </p>
          <Link
            href="/register"
            className="inline-flex items-center px-5 py-2.5 bg-[#0f172a] text-white rounded-full text-sm font-semibold hover:bg-[#1e293b] transition"
          >
            Connect Stripe →
          </Link>
        </div>
      </div>
      </div>
    </section>
  )
}

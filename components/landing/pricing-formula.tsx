import { Check } from 'lucide-react'

/**
 * Reframed pricing block — "$99 + 1 month's fee" formula with two-column breakdown
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
          $99/mo. Then we only earn when we deliver.
        </h2>
        <p className="mt-4 text-sm text-slate-600 max-w-2xl mx-auto">
          Two flows, both bundled. The performance fee only kicks in when we recover a cancelled customer.
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
              <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-slate-500">Monthly platform fee</p>
            </div>
            <div className="text-3xl sm:text-4xl text-slate-400 font-light">+</div>
            <div className="text-center max-w-[18rem]">
              <p className="text-2xl sm:text-3xl font-bold tracking-tight text-blue-600 leading-tight">Customer&apos;s monthly subscription fee</p>
              <p className="mt-2 text-xs font-semibold uppercase tracking-widest text-slate-500">Per win-back recovery</p>
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
                  <span>Up to 500 payment recoveries / month</span>
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
              <p className="mt-1 text-sm font-semibold text-slate-900">Only charged when we recover a customer who deliberately cancelled</p>
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
                  <span className="text-slate-900 font-semibold">Performance-billed — $0 if we don&apos;t recover</span>
                </li>
                <li className="flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Payment recoveries are <span className="font-medium">free</span> (covered by platform fee)</span>
                </li>
              </ul>
            </div>
          </div>

          {/* Worked example */}
          <div className="mt-10 bg-slate-50 border border-slate-200 rounded-2xl px-6 py-5 max-w-2xl mx-auto">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500 mb-2">Worked example</p>
            <p className="text-sm text-slate-700 leading-relaxed">
              A merchant with a typical month: <span className="text-slate-900 font-medium">8 payment failures</span> recovered (free under platform fee), <span className="text-slate-900 font-medium">3 voluntary cancels</span> won back at $20/mo MRR each.
            </p>
            <div className="mt-4 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-xs text-slate-500">Platform</p>
                <p className="text-lg font-semibold text-slate-900">$99</p>
              </div>
              <div>
                <p className="text-xs text-slate-500">Performance (3 × $20)</p>
                <p className="text-lg font-semibold text-slate-900">$60</p>
              </div>
              <div className="border-l border-slate-200 pl-3">
                <p className="text-xs text-slate-500">Total bill</p>
                <p className="text-lg font-bold text-slate-900">$159</p>
              </div>
            </div>

            {/* ROI highlight strip */}
            <div className="mt-5 rounded-xl bg-gradient-to-br from-blue-50 to-blue-50/40 border border-blue-100 px-5 py-4">
              <div className="flex flex-col sm:flex-row items-baseline justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-blue-700">If those 3 stay 12 months</p>
                  <p className="mt-0.5 text-sm text-slate-600">$20 × 3 × 12 months recovered</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold text-slate-900 tabular-nums">$720</p>
                  <p className="text-[11px] text-slate-500">kept revenue</p>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-blue-200/60 flex items-baseline justify-between gap-3">
                <p className="text-sm text-slate-700">Return on the $60 win-back fee</p>
                <p className="text-2xl font-bold text-blue-700 tabular-nums">12×</p>
              </div>
            </div>
          </div>

          {/* Scale strip — same model at other business sizes */}
          <div className="mt-8 max-w-2xl mx-auto">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mb-3">More examples</p>

            <div className="rounded-2xl border border-slate-200 overflow-hidden">
              {/* Header row */}
              <div className="grid grid-cols-12 gap-3 px-5 py-3 bg-slate-50 border-b border-slate-200 text-[10px] font-semibold tracking-widest uppercase text-slate-500">
                <div className="col-span-3">Average MRR</div>
                <div className="col-span-3">Activity</div>
                <div className="col-span-3 text-right">Monthly bill</div>
                <div className="col-span-3 text-right">12-mo recovered</div>
              </div>

              {/* Indie */}
              <div className="grid grid-cols-12 gap-3 px-5 py-4 border-b border-slate-100 items-center">
                <div className="col-span-3 flex items-baseline gap-2">
                  <span className="text-base font-semibold text-slate-900 tabular-nums">$19</span>
                  <span className="text-[10px] uppercase tracking-widest text-slate-400">Indie</span>
                </div>
                <div className="col-span-3 text-sm text-slate-600">2 win-backs · 25 recoveries</div>
                <div className="col-span-3 text-right tabular-nums">
                  <div className="text-sm font-semibold text-slate-900">$137</div>
                  <div className="text-[10px] text-slate-400 leading-tight">$99 + 2×$19</div>
                </div>
                <div className="col-span-3 text-right tabular-nums">
                  <div className="text-sm font-semibold text-emerald-600">$456</div>
                  <div className="text-[10px] text-slate-400 leading-tight">2×$19×12</div>
                </div>
              </div>

              {/* SMB — highlighted as "shown above" since the worked example uses these numbers */}
              <div className="grid grid-cols-12 gap-3 px-5 py-4 border-b border-slate-100 bg-blue-50/40 border-l-4 border-l-blue-500 items-center">
                <div className="col-span-3 flex items-baseline gap-2">
                  <span className="text-base font-semibold text-slate-900 tabular-nums">$20</span>
                  <span className="text-[10px] uppercase tracking-widest text-blue-700 font-semibold">SMB · Shown above</span>
                </div>
                <div className="col-span-3 text-sm text-slate-600">3 win-backs · 40 recoveries</div>
                <div className="col-span-3 text-right tabular-nums">
                  <div className="text-sm font-semibold text-slate-900">$159</div>
                  <div className="text-[10px] text-slate-400 leading-tight">$99 + 3×$20</div>
                </div>
                <div className="col-span-3 text-right tabular-nums">
                  <div className="text-sm font-semibold text-emerald-600">$720</div>
                  <div className="text-[10px] text-slate-400 leading-tight">3×$20×12</div>
                </div>
              </div>

              {/* Mid-market */}
              <div className="grid grid-cols-12 gap-3 px-5 py-4 items-center">
                <div className="col-span-3 flex items-baseline gap-2">
                  <span className="text-base font-semibold text-slate-900 tabular-nums">$89</span>
                  <span className="text-[10px] uppercase tracking-widest text-slate-400">Mid-market</span>
                </div>
                <div className="col-span-3 text-sm text-slate-600">4 win-backs · 30 recoveries</div>
                <div className="col-span-3 text-right tabular-nums">
                  <div className="text-sm font-semibold text-slate-900">$455</div>
                  <div className="text-[10px] text-slate-400 leading-tight">$99 + 4×$89</div>
                </div>
                <div className="col-span-3 text-right tabular-nums">
                  <div className="text-sm font-semibold text-emerald-600">$4,272</div>
                  <div className="text-[10px] text-slate-400 leading-tight">4×$89×12</div>
                </div>
              </div>
            </div>

            <p className="mt-3 text-xs text-slate-400 italic">
              12-month recovered figures assume each won-back customer stays a year. Payment-recovery revenue not included above.
            </p>
          </div>

          {/* Trust strip — 4 reassurance bullets */}
          <div className="mt-8 max-w-2xl mx-auto">
            <div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="flex items-center gap-2 text-sm text-slate-700">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" strokeWidth={2.4} />
                <span>Free until first payment recovery or win-back</span>
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
        </div>

        <div className="bg-slate-50 border-t border-slate-200 px-7 py-6 text-center">
          <p className="text-sm text-slate-600">
            <span className="text-slate-900 font-medium">No card required to sign up.</span>{' '}
            Billing starts on the first delivered payment recovery or win-back.
          </p>
        </div>
      </div>

      {/* Fixed-contract alternative — for teams that need predictable
          budgeting (SSO + signed SLA) instead of the performance model. */}
      <div className="mt-12 max-w-xl mx-auto pt-10 border-t border-slate-200 text-center">
        <h3 className="text-sm font-semibold text-slate-900">
          Need a fixed annual contract?
        </h3>
        <p className="mt-3 text-sm text-slate-500 leading-relaxed">
          For teams that need predictable budgeting with SSO and a signed SLA — we offer fixed annual contracts as an alternative to the performance model.
        </p>
        <a
          href="mailto:sales@winbackflow.co"
          className="mt-4 inline-block text-sm font-medium text-blue-600 hover:text-blue-700"
        >
          sales@winbackflow.co →
        </a>
      </div>
      </div>
    </section>
  )
}

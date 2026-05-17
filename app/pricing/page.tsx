import Link from 'next/link'
import { Check } from 'lucide-react'
import { StickyNav } from '@/components/landing/sticky-nav'
import { PricingFormula } from '@/components/landing/pricing-formula'
import { Footer } from '@/components/landing/footer'

export const metadata = { title: 'Pricing — Winback' }

/**
 * Dedicated /pricing page — extends the home-page 3-card summary
 * (rendered via <PricingFormula />) with the depth a pricing-curious
 * buyer needs before they hit Connect Stripe:
 *
 *   1. <StickyNav />
 *   2. <PricingFormula />               — 3 colored-rail summary cards
 *                                         (slate / blue / emerald) + trust
 *                                         strip + annual-contract escape
 *                                         hatch. Single source of truth.
 *   3. "What each fee covers" section   — 3 colored-rail DETAIL cards
 *                                         matching the summary rails 1:1.
 *                                         Each card lists what the buyer
 *                                         gets for that fee. This is the
 *                                         depth that used to live on the
 *                                         old single-plan PricingFormula.
 *   4. Worked example                   — concrete $99 + $60 = $159 sample
 *                                         month at $20/mo plans, with the
 *                                         12× revenue-won-back ROI tail.
 *   5. How billing works FAQ            — kept from previous /pricing page
 *                                         (when does $99 start, what counts
 *                                         as a win-back, etc.).
 *   6. Footer CTA + <Footer />          — close.
 *
 * Design language matches the colored-rail system used on /payment-recovery,
 * /win-back, the home two-pillar teaser, and the home pricing summary.
 */
export default function PricingPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />

      {/* The 3-card summary the home page also shows. Single source of
          truth for the headline numbers + colored-rail visual anchor. */}
      <PricingFormula />

      {/* ============================================================== */}
      {/*  WHAT EACH FEE COVERS — three colored-rail detail cards,       */}
      {/*  one per summary rail above. Each card explains exactly what   */}
      {/*  that fee gets the buyer, in plain English.                    */}
      {/* ============================================================== */}
      <section className="bg-[#f5f5f5] py-20 sm:py-24 border-t border-slate-100">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center max-w-3xl mx-auto mb-12">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              What each fee covers
            </p>
            <h2 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
              Three fees, in plain English.
            </h2>
            <p className="mt-4 text-sm sm:text-base text-slate-600">
              Same colored rails as the summary above. Read top-to-bottom for
              the full breakdown of what you get and when each fee triggers.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* SLATE — Platform fee: the flat baseline */}
            <div
              className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-slate-400 flex flex-col"
              style={{ backgroundImage: 'linear-gradient(to right, #f8fafc 0%, #ffffff 30%)' }}
            >
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                Platform fee
              </p>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-3xl font-bold text-slate-900 leading-none tabular-nums">$99</span>
                <span className="text-sm text-slate-500">/ month, flat</span>
              </div>
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                What you pay just to have both flows running on your Stripe.
              </p>

              <p className="mt-5 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                Included in the $99
              </p>
              <ul className="mt-3 space-y-2.5 text-sm text-slate-700">
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Both flows running from one Stripe connection</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Live dashboard: pipeline, recovered-vs-lost, MRR impact</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Per-subscriber drawer with AI reasoning + handoff routing</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Promotion-code engine with Winback-verified gates</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Cancel anytime, one click — no setup or onboarding fee</span>
                </li>
              </ul>

              <div className="mt-auto pt-5">
                <p className="text-xs text-slate-500 italic">
                  Free until we deliver your first recovery or win-back — we
                  don&rsquo;t bill the $99 the day you sign up.
                </p>
              </div>
            </div>

            {/* BLUE — Payment recovery: bundled into the platform fee */}
            <div
              className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-blue-600 flex flex-col"
              style={{ backgroundImage: 'linear-gradient(to right, #eff6ff 0%, #ffffff 30%)' }}
            >
              <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-700">
                Payment recovery
              </p>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-3xl font-bold text-slate-900 leading-none">Free</span>
                <span className="text-sm text-slate-500">included in the $99</span>
              </div>
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                Zero per-recovery fee. Up to{' '}
                <strong className="text-slate-800">500 recoveries / month</strong>{' '}
                bundled in.
              </p>

              <p className="mt-5 text-[10px] font-semibold uppercase tracking-widest text-blue-700">
                What runs on every failed payment
              </p>
              <ul className="mt-3 space-y-2.5 text-sm text-slate-700">
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Three-touch email sequence timed to lead Stripe&rsquo;s retries</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Decline-code-aware copy (expired vs insufficient vs hard decline)</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>One-tap update flow: Apple Pay · Google Pay · Stripe Link · card</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Hosted update page on your branded subdomain</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Auto-stop when Stripe finally collects — no double-charging</span>
                </li>
              </ul>

              <div className="mt-auto pt-5">
                <p className="text-xs text-slate-500 italic">
                  Past 500/month? We&rsquo;ll talk — most of our customers
                  never come close.
                </p>
              </div>
            </div>

            {/* EMERALD — Win-back fee: pay-on-success */}
            <div
              className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-emerald-600 flex flex-col"
              style={{ backgroundImage: 'linear-gradient(to right, #ecfdf5 0%, #ffffff 30%)' }}
            >
              <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700">
                Win-back fee
              </p>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-3xl font-bold text-slate-900 leading-none">1&times; Monthly fee</span>
              </div>
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                One month of the won-back customer&rsquo;s own subscription fee.
                Charged once, never recurring.
              </p>

              <p className="mt-5 text-[10px] font-semibold uppercase tracking-widest text-emerald-700">
                When the fee triggers
              </p>
              <ul className="mt-3 space-y-2.5 text-sm text-slate-700">
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>A cancelled subscriber resubscribes via our flow</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>AI-drafted email matched to the cancellation reason cluster</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Refundable in full if they re-cancel within 14 days</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>$0 in months where we deliver no win-backs</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                  <span>Payment recoveries never trigger this fee &mdash; ever</span>
                </li>
              </ul>

              <div className="mt-auto pt-5">
                <p className="text-xs text-slate-500 italic">
                  Our incentive is your incentive: we only earn when you keep
                  a customer that would otherwise be gone.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ============================================================== */}
      {/*  WORKED EXAMPLE — concrete numbers so the formula isn't        */}
      {/*  abstract. Carried over from the previous single-card pricing  */}
      {/*  block; redesigned to fit the new clean white-card style.      */}
      {/* ============================================================== */}
      <section className="bg-white py-20 sm:py-24 border-t border-slate-100">
        <div className="max-w-3xl mx-auto px-6">
          <div className="text-center mb-10">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              Worked example
            </p>
            <h2 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
              What a typical month looks like.
            </h2>
            <p className="mt-3 text-sm text-slate-600 max-w-xl mx-auto">
              A SaaS at <span className="text-slate-900 font-semibold">$20/mo plans</span>: 8 failed payments
              recovered (bundled into the platform fee), plus 3 cancelled customers won back.
            </p>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl px-6 sm:px-8 py-8 shadow-sm">
            <div className="grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-[11px] text-slate-500 uppercase tracking-widest">Platform</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">$99</p>
                <p className="mt-1 text-[11px] text-slate-500">flat</p>
              </div>
              <div>
                <p className="text-[11px] text-blue-700 uppercase tracking-widest">Recoveries</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">$0</p>
                <p className="mt-1 text-[11px] text-slate-500">8 × free</p>
              </div>
              <div>
                <p className="text-[11px] text-emerald-700 uppercase tracking-widest">Win-backs</p>
                <p className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">$60</p>
                <p className="mt-1 text-[11px] text-slate-500">3 × $20</p>
              </div>
            </div>

            <div className="mt-6 pt-5 border-t border-slate-100 flex items-baseline justify-between">
              <p className="text-sm text-slate-600">Total bill this month</p>
              <p className="text-3xl font-bold text-slate-900 tabular-nums">$159</p>
            </div>

            <div className="mt-5 pt-5 border-t border-slate-100 flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-sm text-slate-700">
                If those 3 stay 12 months:{' '}
                <span className="font-semibold text-slate-900">$720 in revenue won back</span>
              </p>
              <p className="text-2xl font-bold text-blue-700 tabular-nums">12&times;</p>
            </div>
          </div>

          <p className="mt-4 text-xs text-slate-400 italic text-center">
            Examples are illustrative; your bill depends on your customers and their subscription fees.
          </p>
        </div>
      </section>

      {/* ============================================================== */}
      {/*  HOW BILLING WORKS FAQ — kept from the previous /pricing.       */}
      {/*  Answers the four most-asked billing questions inline so a     */}
      {/*  buyer doesn't have to email sales for the basics.             */}
      {/* ============================================================== */}
      <section className="bg-[#f5f5f5] py-20 sm:py-24 border-t border-slate-100">
        <div className="max-w-2xl mx-auto px-6">
          <div className="text-center mb-10">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              How billing works
            </p>
            <h2 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
              The four questions buyers ask.
            </h2>
          </div>

          <dl className="divide-y divide-slate-200 bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="px-6 py-5">
              <dt className="text-slate-900 font-medium">When does the $99 start?</dt>
              <dd className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                After we deliver your first payment recovery or win-back,
                whichever comes first. We don&rsquo;t bill the platform fee
                at signup &mdash; it kicks in once we&rsquo;ve actually saved
                you a dollar.
              </dd>
            </div>
            <div className="px-6 py-5">
              <dt className="text-slate-900 font-medium">How is the performance fee charged?</dt>
              <dd className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                One invoice per win-back, equal to{' '}
                <strong>1 month&rsquo;s subscription fee</strong> for that
                subscriber. Charged once &mdash; never recurring. If they
                re-cancel within 14 days, we refund the fee in full.
              </dd>
            </div>
            <div className="px-6 py-5">
              <dt className="text-slate-900 font-medium">What counts as a win-back?</dt>
              <dd className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                <p>A cancelled subscriber comes back after we engaged with them. Specifically, one of:</p>
                <ul className="mt-2 space-y-1.5 list-disc pl-5">
                  <li>They clicked our reactivate link.</li>
                  <li>They replied to our email.</li>
                  <li>They came back within 30 days of us escalating to you (a &ldquo;handoff&rdquo;).</li>
                  <li>They came back within 30 days of you pausing our AI for them.</li>
                </ul>
                <p className="mt-2">
                  Payment recoveries aren&rsquo;t win-backs &mdash; those are
                  covered by the $99/mo platform fee (up to 500/month).
                </p>
              </dd>
            </div>
            <div className="px-6 py-5">
              <dt className="text-slate-900 font-medium">What if no cancellations happen?</dt>
              <dd className="mt-1.5 text-sm text-slate-600 leading-relaxed">
                You still pay $99/mo &mdash; your payment recoveries alone
                justify the platform fee. The performance fee just
                doesn&rsquo;t add anything that month. If neither recoveries
                nor cancellations happen, the $99 doesn&rsquo;t kick in
                until they do.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* Footer CTA — guarantee angle, mirroring the home page close. */}
      <section className="bg-[#eef2fb] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <p className="text-xs font-semibold tracking-widest uppercase text-violet-600">
            No risk, no commitment
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-slate-900">
            Pay nothing until we save you something.
          </h2>
          <p className="mt-4 text-sm text-slate-600 max-w-xl mx-auto">
            14-day money-back guarantee. You pay $0 until we deliver a
            recovery or win-back. Cancel anytime in one click.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              Try free for 14 days &rarr;
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

import Link from 'next/link'
import { Check } from 'lucide-react'
import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'

export const metadata = { title: 'Pricing — Winback' }

/**
 * Dedicated /pricing page.
 *
 * Earlier iteration showed the home-page 3-card summary AND a separate
 * 3-card detail section below it, joined by a "same rails as above"
 * bridge paragraph. That bridge was a tell that the two card grids
 * should just be one: each card now carries its own summary header
 * (eyebrow + price + 1-sentence framing) AND the full detail
 * (labelled checklist + footnote) in a single visual unit.
 *
 * Structure:
 *   1. <StickyNav />
 *   2. Pricing header (same as home: "$99/mo flat. Pay extra only when
 *      we win back a customer." + subhead)
 *   3. THREE colored-rail combined cards (slate / blue / emerald):
 *        • Card top  — eyebrow, price, summary line (matches home)
 *        • Card body — labelled checklist of what runs / what's included
 *        • Card foot — italic footnote
 *   4. Trust strip (4 procurement checkboxes)
 *   5. Worked example block — $99 + $0 + $60 = $159, 12× ROI tail
 *   6. "How billing works" FAQ
 *   7. Fixed annual-contract escape hatch
 *   8. Guarantee-angle footer CTA + Footer
 *
 * The home page's <PricingFormula /> still renders the slim 3-card
 * summary; this page renders its own deeper version of the same 3
 * cards. They stay in visual sync because they share the rail colours,
 * gradient values, border, shadow, and eyebrow / price typography.
 */
export default function PricingPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />

      <section id="pricing" className="bg-white py-20 sm:py-24 border-t border-slate-100">
        <div className="max-w-6xl mx-auto px-6">
          {/* Header — same headline as the home summary so the page reads
              continuously when arriving via the home "See full pricing"
              link, but with a /pricing-specific subhead that signals
              "this is the detail view." */}
          <div className="text-center max-w-3xl mx-auto">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              Pricing
            </p>
            <h1 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
              $99/mo flat. Pay extra only when we win back a customer.
            </h1>
            <p className="mt-4 text-sm sm:text-base text-slate-600">
              Three fees, in plain English &mdash; what you pay, what runs, and exactly when each fee triggers.
            </p>
          </div>

          {/* Three combined cards — summary header + full detail inside
              each card. No bridge text needed; the cards ARE the bridge. */}
          <div className="mt-12 grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* SLATE — Platform fee */}
            <div
              className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-slate-400 flex flex-col"
              style={{ backgroundImage: 'linear-gradient(to right, #f8fafc 0%, #ffffff 30%)' }}
            >
              <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                Platform fee
              </p>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-4xl font-bold text-slate-900 leading-none tabular-nums">$99</span>
                <span className="text-sm text-slate-500">/ month, flat</span>
              </div>
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                What you pay to have both flows running on your Stripe.
              </p>

              <div className="mt-5 pt-5 border-t border-slate-100">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
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
                    <span>Cancel anytime, one click &mdash; no setup or onboarding fee</span>
                  </li>
                </ul>
              </div>

              <div className="mt-auto pt-5">
                <p className="text-xs text-slate-500 italic">
                  Free until we deliver your first recovery or win-back &mdash;
                  we don&rsquo;t bill the $99 the day you sign up.
                </p>
              </div>
            </div>

            {/* BLUE — Payment recovery */}
            <div
              className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-blue-600 flex flex-col"
              style={{ backgroundImage: 'linear-gradient(to right, #eff6ff 0%, #ffffff 30%)' }}
            >
              <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-700">
                Payment recovery
              </p>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-4xl font-bold text-slate-900 leading-none">Free</span>
                <span className="text-sm text-slate-500">included in the $99</span>
              </div>
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                Zero per-recovery fee. Up to{' '}
                <strong className="text-slate-800">500 recoveries / month</strong>{' '}
                bundled in.
              </p>

              <div className="mt-5 pt-5 border-t border-blue-100/60">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-700">
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
                    <span>One-tap update flow: Apple Pay &middot; Google Pay &middot; Stripe Link &middot; card</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                    <span>Hosted update page on your branded subdomain</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                    <span>Auto-stop when Stripe finally collects &mdash; no double-charging</span>
                  </li>
                </ul>
              </div>

              <div className="mt-auto pt-5">
                <p className="text-xs text-slate-500 italic">
                  Past 500/month? We&rsquo;ll talk &mdash; most of our
                  customers never come close.
                </p>
              </div>
            </div>

            {/* EMERALD — Win-back fee */}
            <div
              className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-emerald-600 flex flex-col"
              style={{ backgroundImage: 'linear-gradient(to right, #ecfdf5 0%, #ffffff 30%)' }}
            >
              <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700">
                Win-back fee
              </p>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-4xl font-bold text-slate-900 leading-none">1&times; Monthly fee</span>
              </div>
              <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                One month of the won-back customer&rsquo;s own subscription
                fee. Charged once, never recurring.
              </p>

              <div className="mt-5 pt-5 border-t border-emerald-100/60">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700">
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
              </div>

              <div className="mt-auto pt-5">
                <p className="text-xs text-slate-500 italic">
                  Our incentive is your incentive: we only earn when you
                  keep a customer that would otherwise be gone.
                </p>
              </div>
            </div>
          </div>

          {/* Trust strip — procurement checkboxes (cancel anytime, no
              setup, refund window). Carried over from the old
              PricingFormula since /pricing still needs the buyer-
              reassurance row right under the cards. */}
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
        </div>
      </section>

      {/* ============================================================== */}
      {/*  WORKED EXAMPLE — concrete numbers so the formula isn't        */}
      {/*  abstract. Compact single-card layout: header lives INSIDE     */}
      {/*  the card, stat row + total + ROI tail stack tightly with      */}
      {/*  thinner dividers and smaller numbers. Roughly half the        */}
      {/*  vertical real estate of the previous version.                 */}
      {/* ============================================================== */}
      <section className="bg-[#f5f5f5] py-12 sm:py-14 border-t border-slate-100">
        <div className="max-w-2xl mx-auto px-6">
          <div className="bg-white border border-slate-200 rounded-2xl px-5 sm:px-6 py-5 shadow-sm">
            {/* Inline header — eyebrow + headline + one-liner setup */}
            <div className="flex items-baseline justify-between gap-3 mb-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-600">
                  Worked example
                </p>
                <p className="mt-0.5 text-sm font-semibold text-slate-900">
                  A typical month at $20/mo plans
                </p>
              </div>
              <p className="text-[11px] text-slate-500 text-right">
                8 recoveries<br />+ 3 win-backs
              </p>
            </div>

            {/* Stat row */}
            <div className="grid grid-cols-3 gap-3 text-center pt-4 border-t border-slate-100">
              <div>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest">Platform</p>
                <p className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums">$99</p>
              </div>
              <div>
                <p className="text-[10px] text-blue-700 uppercase tracking-widest">Recoveries</p>
                <p className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums">$0</p>
              </div>
              <div>
                <p className="text-[10px] text-emerald-700 uppercase tracking-widest">Win-backs</p>
                <p className="mt-0.5 text-lg font-semibold text-slate-900 tabular-nums">$60</p>
              </div>
            </div>

            {/* Bill + ROI on a single row */}
            <div className="mt-4 pt-4 border-t border-slate-100 flex items-baseline justify-between gap-3">
              <p className="text-sm text-slate-600">
                Total this month
              </p>
              <p className="text-xl font-bold text-slate-900 tabular-nums">$159</p>
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-3">
              <p className="text-xs text-slate-500">
                If those 3 stay 12 months: <span className="text-slate-700 font-medium">$720 won back</span>
              </p>
              <p className="text-base font-bold text-blue-700 tabular-nums">12&times;</p>
            </div>
          </div>

          <p className="mt-3 text-[11px] text-slate-400 italic text-center">
            Illustrative; your bill depends on your customers&rsquo; subscription fees.
          </p>
        </div>
      </section>

      {/* ============================================================== */}
      {/*  HOW BILLING WORKS FAQ — kept from the previous /pricing.       */}
      {/* ============================================================== */}
      <section className="bg-white py-20 sm:py-24 border-t border-slate-100">
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

          {/* Fixed annual contract escape hatch — moved here so the
              pricing section ends with the answers, not with sales copy. */}
          <div className="mt-12 max-w-xl mx-auto pt-10 border-t border-slate-200 text-center">
            <h3 className="text-sm font-semibold text-slate-900">
              Need a fixed annual contract?
            </h3>
            <p className="mt-3 text-sm text-slate-500 leading-relaxed">
              For teams that need predictable budgeting with SSO and a
              signed SLA &mdash; we offer fixed annual contracts as an
              alternative to the performance model.
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

      {/* Footer CTA — guarantee angle, mirrors the home page close.
          Copy precision: no general money-back, no 14-day free trial.
          You pay $0 until we deliver a save; win-back fees are
          refunded only if the won-back customer re-cancels within
          14 days. CTA text matches the Hero ("Start free — no card")
          rather than the misleading "Try free for 14 days". */}
      <section className="bg-[#eef2fb] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <p className="text-xs font-semibold tracking-widest uppercase text-violet-600">
            No risk, no commitment
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-slate-900">
            Pay nothing until we save you something.
          </h2>
          <p className="mt-4 text-sm text-slate-600 max-w-xl mx-auto">
            You pay $0 until we deliver a payment recovery or win-back.
            Win-back fees are refunded if the customer re-cancels within
            14 days. Cancel anytime in one click.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              Start free &mdash; no card &rarr;
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

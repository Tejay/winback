import Link from 'next/link'
import { Check } from 'lucide-react'

/**
 * Pricing block — $99/mo platform + one month of the won-back
 * subscriber's subscription fee per win-back; we recover failed
 * payments under the platform fee. Single plan, single card.
 *
 * Naming convention (founder review):
 * - "win-back" applies to cancelled customers we bring back; "payment
 *   recovery / recover" applies to failed payments we save. Don't
 *   conflate ("win-back recovery" is wrong).
 * - User-facing copy avoids jargon like "MRR" — uses "subscription
 *   fee" instead.
 *
 * Cleanup pass (founder review): the previous version packed seven
 * competing visual blocks into one card (math expression + two-column
 * features + worked example + ROI strip + scale table + trust strip +
 * footer). Each was good in isolation but they fought for attention.
 *
 * New structure:
 *   1. Section header (unchanged copy)
 *   2. ONE plan card — big $99 + formula subtitle, single what's-included
 *      list, performance-fee details, inline CTA, footnote
 *   3. ONE worked example panel below the card (with ROI baked in —
 *      replaces the standalone ROI strip + scale table)
 *   4. Trust strip (kept as-is)
 *   5. Fixed-contract alternative footnote (kept as-is)
 *
 * Same billing model. Same numbers. Less noise.
 */
export function PricingFormula() {
  return (
    <section id="pricing" className="bg-[#f5f5f5] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center mb-10">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">Pricing</p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
            $99/month, plus performance.
          </h2>
          <p className="mt-4 text-sm text-slate-600 max-w-2xl mx-auto">
            Flat platform fee, plus a one-time fee per win-back we actually
            deliver. Refundable if they re-cancel within 14 days. Payment
            recoveries free.
          </p>
        </div>

        {/* The plan card */}
        <div className="max-w-2xl mx-auto bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
          {/* Headline price */}
          <div className="px-7 sm:px-10 pt-10 pb-8 text-center border-b border-slate-100">
            <div className="flex items-baseline justify-center gap-1">
              <span className="text-6xl sm:text-7xl font-bold tracking-tight text-slate-900 leading-none tabular-nums">$99</span>
              <span className="text-xl text-slate-500 font-medium">/month</span>
            </div>
            <p className="mt-4 text-sm text-slate-600 max-w-md mx-auto leading-relaxed">
              Plus <span className="font-semibold text-slate-900">one month of the won-back subscriber&rsquo;s subscription fee</span>{' '}
              per win-back &mdash; charged once, never recurring.
            </p>
            <p className="mt-5 text-emerald-700 text-sm font-semibold">
              Free until we deliver a payment recovery or win-back a cancelled customer
            </p>
          </div>

          {/* What's included — single list, no two-column split. Heading
              explicitly names payment recoveries so prospects know they're
              bundled into the platform fee, not a separate add-on. */}
          <div className="px-7 sm:px-10 py-7 border-b border-slate-100">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-blue-600 mb-3">
              Payment recoveries + platform tools &mdash; included
            </p>
            <ul className="space-y-2.5 text-sm text-slate-700">
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                <span>Up to 500 payment recoveries per month (no per-recovery fee)</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                <span>Three-touch decline-aware email sequence per failed payment</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                <span>One-tap update flow: Apple Pay, Google Pay, Link, card</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                <span>AI classifier + win-back drafts on every cancellation</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                <span>Per-subscriber drawer with AI reasoning + handoff routing</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                <span>Dashboard with live pipeline + recovered-vs-lost tracking</span>
              </li>
            </ul>
          </div>

          {/* Performance pricing for win-backs — heading echoes the
              page-level "$99/month, plus performance." headline one beat
              below, so prospects see "performance" twice in close proximity.
              "for win-backs" makes scope unambiguous — payment recoveries
              are obviously not in this scope. First bullet states the
              amount in plain English (1 month of the customer's
              subscription fee, no MRR jargon). */}
          <div className="px-7 sm:px-10 py-7 border-b border-slate-100">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-blue-600 mb-3">
              Performance pricing for win-backs
            </p>
            <ul className="space-y-2.5 text-sm text-slate-700">
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                <span>1 month of the won-back customer&rsquo;s subscription fee &mdash; charged once per win-back, never recurring</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                <span>Refundable in full if they re-cancel within 14 days</span>
              </li>
              <li className="flex items-start gap-2.5">
                <Check className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" strokeWidth={2.2} />
                <span>Payment recoveries don&rsquo;t trigger this fee &mdash; ever</span>
              </li>
            </ul>
          </div>

          {/* Inline CTA + footnote */}
          <div className="px-7 sm:px-10 py-8 text-center bg-slate-50">
            <Link
              href="/register"
              className="inline-flex items-center bg-[#0f172a] text-white rounded-full px-7 py-3 text-sm font-semibold hover:bg-[#1e293b] transition-colors"
            >
              Connect Stripe in 60 seconds &rarr;
            </Link>
            <p className="mt-4 text-xs text-slate-500 leading-relaxed">
              <span className="text-slate-700 font-medium">No card required to sign up.</span>{' '}
              Billing starts on the first delivered payment recovery or win-back.
            </p>
          </div>
        </div>

        {/* Worked example — under the card, with ROI baked in (replaces the
            standalone ROI strip + scale table from the previous version). */}
        <div className="mt-10 max-w-2xl mx-auto">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mb-3 text-center">
            Example month
          </p>
          <div className="bg-white border border-slate-200 rounded-2xl px-6 py-6">
            <p className="text-sm text-slate-700 leading-relaxed">
              A SaaS at <span className="text-slate-900 font-semibold">$20/mo plans</span>:
              8 payment recoveries (free under platform) plus
              <span className="text-slate-900 font-semibold"> 3 win-backs</span> at $20/mo subscription fee each.
            </p>
            <div className="mt-5 grid grid-cols-3 gap-3 text-center">
              <div>
                <p className="text-[11px] text-slate-500 uppercase tracking-widest">Platform</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 tabular-nums">$99</p>
              </div>
              <div>
                <p className="text-[11px] text-slate-500 uppercase tracking-widest">Win-backs</p>
                <p className="mt-1 text-xl font-semibold text-slate-900 tabular-nums">$60</p>
              </div>
              <div className="border-l border-slate-200 pl-3">
                <p className="text-[11px] text-slate-500 uppercase tracking-widest">Bill</p>
                <p className="mt-1 text-xl font-bold text-slate-900 tabular-nums">$159</p>
              </div>
            </div>

            {/* ROI tail — folded into the worked example */}
            <div className="mt-5 pt-5 border-t border-slate-100 flex flex-wrap items-baseline justify-between gap-3">
              <p className="text-sm text-slate-700">
                If those 3 stay 12 months: <span className="font-semibold text-slate-900">$720 in revenue won back</span>
              </p>
              <p className="text-2xl font-bold text-blue-700 tabular-nums">12&times;</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-400 italic text-center">
            Examples are illustrative; your bill depends on your customers and their subscription fees.
          </p>
        </div>

        {/* Trust strip — kept verbatim */}
        <div className="mt-8 max-w-2xl mx-auto">
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

        {/* Fixed-contract alternative — kept verbatim */}
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

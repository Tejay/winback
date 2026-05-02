/**
 * "Why Winback?" — head-on answer to the objection every prospect on this
 * page is silently asking ("Stripe already retries cards, why pay you?").
 * Sits between Timeline (which proves our timing claim) and the heavyweight
 * proof sections (CheckoutMockup, EmailComparison) so it intercepts the
 * objection before the prospect bounces from the page.
 *
 * Honest framing: we don't replace Stripe's Smart Retries — we augment them.
 * The 80% number references the demo dashboard so prospects can verify.
 */

import Link from 'next/link'

export function WhyNotStripe() {
  return (
    <section className="bg-[#f5f5f5] py-16 sm:py-20">
      <div className="max-w-3xl mx-auto px-6">
        <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
          Common question
        </div>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
          Why not just rely on Stripe&rsquo;s retries?
        </h2>

        <div className="mt-6 space-y-4 text-base text-slate-600 leading-relaxed">
          <p>
            Stripe&rsquo;s Smart Retries silently recover roughly half of failed
            charges on their own &mdash; they pick optimal retry times and
            re-attempt the card. That&rsquo;s good. We don&rsquo;t replace it.
          </p>
          <p>
            What Stripe&rsquo;s retries <em>don&rsquo;t</em> do: tell the
            customer <em>why</em> the card failed in language they understand,
            give them a one-tap update flow they can complete on their phone
            in ten seconds, or coordinate the email cadence with your brand
            in front.
          </p>
          <p>
            Together, Stripe&rsquo;s automatic retries plus our timed,
            decline-aware emails get to roughly{' '}
            <Link
              href="/demo/payment-recovery"
              className="text-emerald-700 font-semibold hover:underline"
            >
              80% recovery
            </Link>
            {' '}on involuntary churn. The other ~20% is hardship cases
            (declined card with no working backup) &mdash; those will churn
            either way.
          </p>
        </div>
      </div>
    </section>
  )
}

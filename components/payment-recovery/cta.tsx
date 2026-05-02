import Link from 'next/link'

/**
 * Final CTA on /payment-recovery. De-risks before asking — three short
 * lines that surface the pricing shape, time-to-value, and the no-card-
 * at-signup reassurance that's already true. Headline + button unchanged.
 * Pricing details still link out to the home /pricing page (combined
 * billing for both flows).
 */
export function Cta() {
  return (
    <section className="bg-[#eef2fb] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6 text-center">
        <div className="text-xs font-semibold tracking-widest uppercase text-violet-600">
          Ready to start?
        </div>
        <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
          Plug in. Stop the leak.
        </h2>

        <ul className="mt-7 space-y-2 text-sm text-slate-600 max-w-md mx-auto text-left">
          <li className="flex items-baseline gap-2">
            <span className="text-blue-600 font-semibold flex-shrink-0">·</span>
            <span>
              <span className="font-semibold text-slate-900">$99/mo flat</span> &mdash;
              payment recovery included, no per-save cut
            </span>
          </li>
          <li className="flex items-baseline gap-2">
            <span className="text-blue-600 font-semibold flex-shrink-0">·</span>
            <span>
              First failure email sends within{' '}
              <span className="font-semibold text-slate-900">60 seconds</span> of the
              next Stripe webhook
            </span>
          </li>
          <li className="flex items-baseline gap-2">
            <span className="text-blue-600 font-semibold flex-shrink-0">·</span>
            <span>
              <span className="font-semibold text-slate-900">No card at signup</span>{' '}
              &mdash; you pay nothing until we deliver your first recovery
            </span>
          </li>
        </ul>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/register"
            className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
          >
            Connect Stripe in 60 seconds &rarr;
          </Link>
          <Link
            href="/#pricing"
            className="text-slate-600 hover:text-slate-900 text-sm font-medium px-3 py-2.5"
          >
            See full pricing &rarr;
          </Link>
        </div>
        <p className="mt-6 text-xs text-slate-500">
          Stripe Connect Standard.
        </p>
      </div>
    </section>
  )
}

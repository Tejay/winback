import { PaymentFlowIllustration } from './payment-flow-illustration'

/**
 * /payment-recovery hero. Mirrors components/win-back/hero.tsx in shape
 * (full-bleed eef2fb section, headline + subhead + flow illustration
 * below) so the two product pages feel like one product. Subhead trimmed
 * per founder review — the page below proves the claim.
 */
export function Hero() {
  return (
    <section className="bg-[#eef2fb] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6 flex flex-col items-center">
        <div className="max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
            Payment recovery
          </p>
          <h1 className="mt-4 text-4xl sm:text-5xl font-bold tracking-tight text-slate-900">
            Card failures don&apos;t have to cost you customers.
          </h1>
          <p className="mt-5 text-base sm:text-lg text-slate-600 leading-relaxed">
            The average subscription business loses 5&ndash;7% of MRR every
            year to involuntary churn &mdash; payment failures that quietly
            remove customers who would have stayed.{' '}
            <span className="text-slate-900 font-medium">Winback recovers it automatically.</span>
          </p>
        </div>

        <PaymentFlowIllustration />
      </div>
    </section>
  )
}

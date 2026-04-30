/**
 * /payment-recovery hero. Full-bleed section with its own bg so the page has
 * visual rhythm matching the original home (eef2fb hero → f5f5f5 sections).
 */
export function Hero() {
  return (
    <section className="bg-[#eef2fb] py-20 sm:py-24">
      <div className="max-w-3xl mx-auto px-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
          Payment recovery
        </p>
        <h1 className="mt-4 text-4xl sm:text-5xl font-bold tracking-tight text-slate-900">
          Card failures don&apos;t have to cost you customers.
        </h1>
        <p className="mt-5 text-base sm:text-lg text-slate-600 leading-relaxed">
          The average subscription business loses 5–7% of MRR every year to involuntary churn — payment failures that quietly remove customers who would have stayed.{' '}
          <span className="text-slate-900 font-medium">Winback recovers it automatically.</span>{' '}
          Three perfectly-timed emails, decline-aware coaching, and a one-tap update flow built around Apple Pay, Google Pay, and Link — not just card.
        </p>
      </div>
    </section>
  )
}

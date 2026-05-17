/**
 * Bundle callout — the "what makes it different" beat between the Hero
 * and the two-pillar teaser.
 *
 * Replaces the previous platform-bundle visual (Winback Platform badge
 * + two feature-card grid). Now leads with the differentiator: every
 * email is targeted to the specific reason behind the failure or
 * cancellation. The two-pillar teaser below carries the per-flow
 * proof so we don't need to repeat it here.
 *
 * Honest about mechanism: payment recovery uses rule-based decline-
 * aware copy (no AI claim); win-back uses AI. We don't overclaim AI
 * on the payment-recovery side.
 */
export function BundleCallout() {
  return (
    <section className="bg-white py-16">
      <div className="max-w-3xl mx-auto px-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
          What makes it different
        </p>
        <h2 className="mt-3 text-2xl sm:text-3xl font-bold tracking-tight text-slate-900">
          Read the actual reason. Respond specifically.
        </h2>
        <p className="mt-3 text-sm sm:text-base text-slate-600">
          Failed payments get decline-aware copy. Cancellations get an AI-written response. Either way — every email is targeted, never templated.
        </p>
      </div>
    </section>
  )
}

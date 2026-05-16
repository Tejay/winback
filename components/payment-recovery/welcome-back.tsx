/**
 * Section "05 · Welcome back" — the celebratory landing the customer sees
 * after they successfully update their card and the open invoice is paid.
 *
 * Pixel-matches the real /welcome-back page (app/welcome-back/page.tsx)
 * success state so the marketing page shows what actually ships, not a
 * gussied-up mockup. Keep them in lock-step if either side changes.
 *
 * Closes the four-step story: how it works → email → dashboard → click →
 * recovered. Ends on a positive moment (the customer is back) before the
 * final CTA.
 */
export function WelcomeBack() {
  return (
    <section className="bg-[#f5f5f5] py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-5xl mx-auto px-6">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">05 · Welcome back</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
            The customer finishes on this.
          </h2>
          <p className="mt-4 text-sm text-slate-600 max-w-2xl mx-auto">
            Card updated. Invoice paid. Subscription active again. They see your
            brand at the top, a clean celebratory card, and nothing about Winback.
          </p>
        </div>

        <div className="mt-12 flex justify-center">
          {/* Pixel match of the live /welcome-back success state — see
              app/welcome-back/page.tsx. */}
          <div className="w-full max-w-md">
            <div className="mb-8 text-2xl font-semibold text-slate-900 tracking-tight text-center">
              Your brand
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center">
              <div className="text-4xl mb-4">🎉</div>
              <h3 className="text-2xl font-bold text-slate-900 mb-2">
                Welcome back!
              </h3>
              <p className="text-sm text-slate-500">
                Thanks for giving us another try. Your subscription is active again.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

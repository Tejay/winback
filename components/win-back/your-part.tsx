/**
 * /win-back · "Your part" section — sits between HowItWorks and the
 * dashboard preview. Tells the merchant in one card what they actually
 * do: address a cancellation reason, and we email the specific people
 * who cited it.
 *
 * The visual is a before → after pair that mirrors the Hero's
 * cancellation → AI → recovery flow but at a more strategic level:
 *
 *   [ Customer's cancellation theme ]  →  [ Your shipped change ]
 *
 * The left card uses the same red-rail / soft-tint treatment as the
 * real Suggested-tab themes on /reasons; the right card uses an
 * emerald accent for the recovered/active reason.
 *
 * Visual language locked to the rest of the page:
 *   - rounded-2xl + slate-100 border + shadow-sm
 *   - colored 4px left rails (matches How it works step cards once
 *     they get rails too)
 *   - section background bg-[#f5f5f5] so the rhythm is
 *     blue (Hero) → white (How it works) → grey (Your part) →
 *     white (Dashboard) → blue (CTA)
 */
export function YourPart() {
  return (
    <section className="bg-[#f5f5f5] py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-5xl mx-auto px-6">
        <div className="text-center max-w-3xl mx-auto">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Your part
          </div>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
            You handle the change. We notify everyone who cancelled over it.
          </h2>
          <p className="mt-4 text-sm sm:text-base text-slate-600 leading-relaxed">
            Our AI groups cancellation reasons into themes — so when you fix something, we email only the customers who specifically asked for it.
          </p>
        </div>

        {/* Before → after loop */}
        <div className="mt-12 grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr] items-center gap-6 lg:gap-4">
          {/* LEFT — clustered cancellation theme (what customers asked for) */}
          <div
            className="rounded-2xl border border-slate-100 shadow-sm p-6 border-l-4 border-l-red-600"
            style={{ backgroundImage: 'linear-gradient(to right, #fef2f2 0%, #ffffff 30%)' }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-3">
              What customers asked for
            </div>
            <div className="flex items-start gap-4">
              <div className="text-center shrink-0 w-14">
                <div className="text-4xl font-bold text-red-600 leading-none">5</div>
                <div className="text-[10px] uppercase tracking-widest text-slate-500 mt-1.5 font-medium">
                  customers
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-slate-900 leading-tight">
                  Native Slack integration
                </h4>
                <p className="text-xs text-slate-600 mt-1.5">
                  Wanted a first-party Slack app with channel routing, not the Zapier workaround.
                </p>
                <p className="text-xs text-slate-500 italic mt-2">
                  &ldquo;Cancelling — ping me when there&rsquo;s a proper Slack app.&rdquo;
                </p>
              </div>
            </div>
          </div>

          {/* Arrow — flips to vertical on mobile */}
          <div className="flex items-center justify-center lg:flex-col gap-1 text-slate-400">
            <span className="text-xs font-semibold uppercase tracking-widest">You ship</span>
            <svg
              className="w-8 h-8 lg:rotate-0 rotate-90"
              viewBox="0 0 32 32"
              fill="none"
              aria-hidden
            >
              <line x1="4" y1="16" x2="26" y2="16" stroke="#3b82f6" strokeWidth="2" strokeDasharray="4 4" />
              <polyline points="22,10 28,16 22,22" stroke="#3b82f6" strokeWidth="2" fill="none" strokeLinejoin="round" />
            </svg>
          </div>

          {/* RIGHT — your shipped reason (active row) */}
          <div className="rounded-2xl border border-emerald-200 bg-white shadow-sm p-6">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700 mb-3">
              Your shipped reason
            </div>
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                <svg
                  className="w-4 h-4 text-emerald-700"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth={2.5}
                  aria-hidden
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-slate-900 leading-tight">
                  Shipped Slack integration with channel routing
                </h4>
                <p className="text-xs text-slate-600 mt-1.5">
                  Live Slack app · two-way sync · per-channel routing.
                </p>
                <p className="text-xs text-slate-400 mt-2">Shipped 3 days ago</p>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-slate-100 flex items-center gap-2 text-xs">
              <svg
                className="w-3.5 h-3.5 text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                strokeWidth={2}
                aria-hidden
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span className="text-slate-700">
                <span className="font-semibold text-slate-900">5 customers</span>{' '}
                emailed automatically
              </span>
            </div>
          </div>
        </div>

        <p className="mt-10 text-center text-xs text-slate-500">
          Plus a discount fallback for price-cancellers — pick a Stripe coupon, we apply it on reactivation.
        </p>
      </div>
    </section>
  )
}

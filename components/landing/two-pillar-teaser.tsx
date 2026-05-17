import Link from 'next/link'

/**
 * Two side-by-side teaser cards on the home page. Each one is a clickable
 * link to its dedicated deep page (/payment-recovery or /win-back).
 *
 * Each card carries:
 *   • Icon + eyebrow (rail-coloured)
 *   • Headline + short body
 *   • A two-zone proof box: WHAT WE READ (the intelligence we apply)
 *     and WHAT THEY SEE (what the customer experiences) side-by-side
 *     with a vertical divider
 *   • A "See how X works →" link
 *
 * Visual consistency with /win-back and /payment-recovery deep pages:
 *   - colored 4px left rail (blue / emerald)
 *   - soft gradient tint matching the rail
 *   - rounded-2xl + slate-100 border + shadow-sm
 *
 * Compact profile (cards ~430px tall) achieved via:
 *   - wider container (max-w-6xl) so side-by-side proof zones fit
 *   - bodies trimmed to two short sentences
 *   - inner labelled-text proof zones (no oversized count anchors)
 */
export function TwoPillarTeaser() {
  return (
    <section className="bg-[#f5f5f5] py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-6xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center max-w-3xl mx-auto mb-12">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
            The two flows
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
            Both flows, side by side.
          </h2>
          <p className="mt-4 text-sm sm:text-base text-slate-600">
            You get both running from one Stripe connection — each with its own dashboard, its own emails, its own recovery surface. Tap a card for the full story.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* LEFT — Payment recovery (blue rail) */}
          <Link
            href="/payment-recovery"
            className="group rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition p-6 border-l-4 border-l-blue-600 flex flex-col"
            style={{ backgroundImage: 'linear-gradient(to right, #eff6ff 0%, #ffffff 30%)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-lg" aria-hidden>💳</span>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">
                Payment recovery
              </p>
            </div>
            <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">
              When cards fail.
            </h3>
            <p className="mt-2.5 text-sm text-slate-600 leading-relaxed">
              Three perfectly-timed emails that lead Stripe&rsquo;s retries. Decline-aware copy. One-tap update with the wallet they already have.
            </p>

            {/* Proof box — side-by-side zones */}
            <div className="mt-5 rounded-xl bg-white/60 border border-blue-100/60 overflow-hidden grid grid-cols-2 divide-x divide-slate-100">
              {/* Zone 1: WHAT WE READ */}
              <div className="p-4">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">What we read</p>
                <div className="rounded-lg bg-white border border-slate-100 p-3 text-xs">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-blue-600 mb-0.5">Why this happened</p>
                  <p className="text-slate-900 leading-snug">Your card expired since the last successful charge.</p>
                </div>
              </div>
              {/* Zone 2: WHAT THEY SEE */}
              <div className="p-4">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">What they see</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {/* Apple Pay */}
                  <button type="button" className="py-2 bg-black text-white rounded-md text-xs font-semibold flex items-center justify-center gap-0.5" tabIndex={-1}>
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M17.05 11.97c-.027-2.82 2.302-4.17 2.408-4.236-1.317-1.92-3.357-2.183-4.078-2.21-1.733-.18-3.387 1.02-4.27 1.02-.886 0-2.241-.998-3.687-.97-1.897.027-3.659 1.105-4.633 2.793-1.978 3.422-.504 8.473 1.41 11.244.937 1.358 2.05 2.879 3.51 2.825 1.416-.057 1.95-.91 3.66-.91 1.71 0 2.19.91 3.687.879 1.524-.027 2.488-1.385 3.42-2.747 1.077-1.575 1.519-3.103 1.546-3.18-.034-.014-2.964-1.135-2.973-4.508zm-2.78-8.282c.78-.949 1.31-2.265 1.166-3.581-1.128.046-2.504.752-3.314 1.7-.724.834-1.366 2.18-1.196 3.474 1.262.097 2.553-.642 3.344-1.593z"/>
                    </svg>
                    <span>Pay</span>
                  </button>
                  {/* Google Pay */}
                  <button type="button" className="py-2 bg-black text-white rounded-md text-xs font-semibold flex items-center justify-center gap-1" tabIndex={-1}>
                    <svg className="w-3 h-3" viewBox="0 0 24 24" aria-hidden>
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    <span>Pay</span>
                  </button>
                  {/* Link */}
                  <button type="button" className="py-2 bg-emerald-500 text-white rounded-md text-xs font-semibold flex items-center justify-center" tabIndex={-1}>
                    <span className="bg-black text-emerald-400 px-1 py-0.5 rounded font-bold tracking-tight text-[10px]">link</span>
                  </button>
                </div>
                <p className="text-xs text-slate-500 mt-2 leading-snug">One tap, no card to retype.</p>
              </div>
            </div>

            <div className="mt-auto pt-5 inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 group-hover:gap-2.5 transition-all">
              See how payment recovery works →
            </div>
          </Link>

          {/* RIGHT — Win-back (emerald rail) */}
          <Link
            href="/win-back"
            className="group rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition p-6 border-l-4 border-l-emerald-600 flex flex-col"
            style={{ backgroundImage: 'linear-gradient(to right, #ecfdf5 0%, #ffffff 30%)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-lg" aria-hidden>✉️</span>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
                Win-back
              </p>
            </div>
            <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">
              When customers cancel.
            </h3>
            <p className="mt-2.5 text-sm text-slate-600 leading-relaxed">
              AI clusters cancellation reasons weekly. You provide the reasons; we email the exact customers who cited each one.
            </p>

            {/* Proof box — side-by-side zones */}
            <div className="mt-5 rounded-xl bg-white/60 border border-emerald-100/60 overflow-hidden grid grid-cols-2 divide-x divide-slate-100">
              {/* Zone 1: WHAT WE READ */}
              <div className="p-4">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">What we read</p>
                <div className="rounded-lg bg-white border border-slate-100 p-3 text-xs">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-700 mb-0.5">A theme we clustered</p>
                  <p className="text-slate-900 leading-snug">5 customers asked for native Slack integration:</p>
                  <p className="text-slate-900 leading-snug italic mt-1">&ldquo;Ping me when there&rsquo;s a proper Slack app.&rdquo;</p>
                </div>
              </div>
              {/* Zone 2: WHAT THEY SEE */}
              <div className="p-4">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2">What they see</p>
                <div className="rounded-lg bg-white border border-slate-100 p-3 text-xs leading-snug">
                  <p className="text-slate-900">Hi Sarah,</p>
                  <p className="text-slate-900 mt-1">You asked for Slack — it&rsquo;s live. Worth another look?</p>
                  <p className="text-slate-900 mt-1">— Alex</p>
                  <span className="mt-2 inline-flex items-center px-3 py-1.5 bg-[#0f172a] text-white rounded-full text-[11px] font-medium">
                    Resubscribe
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-auto pt-5 inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 group-hover:gap-2.5 transition-all">
              See how win-back works →
            </div>
          </Link>
        </div>
      </div>
    </section>
  )
}

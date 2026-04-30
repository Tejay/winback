/**
 * Section 5 — featured Stripe-Checkout-style update-payment mockup with three
 * left-rail callouts. Mirrors the user's reference screenshot.
 *
 * The mockup intentionally matches Stripe Checkout's setup-mode UI so visitors
 * recognise it from real-world payments. Buttons are static; this is a marketing
 * preview, not an interactive form.
 */

const RAIL_POINTS = [
  {
    title: 'Wallets surface first',
    body: "On Safari → Apple Pay. On Chrome → Google Pay. Link surfaces everywhere. The customer's already-saved card on their phone is one tap away — no typing.",
  },
  {
    title: 'Bank, Klarna, Afterpay',
    body: 'Every payment method the merchant has enabled in Stripe shows up automatically — including bank debit and BNPL. No extra config, no extra code.',
  },
  {
    title: 'Failed invoice retried instantly',
    body: "The moment a new card is attached, we retry the open invoice server-side. No waiting for Stripe's next scheduled retry — recovery in seconds, not days.",
  },
]

export function CheckoutMockup() {
  return (
    <section className="bg-white py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-5xl mx-auto px-6">
        <div className="max-w-3xl mx-auto text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">When they click</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
          Every payment method, one tap to fix.
        </h2>
        <p className="mt-4 text-sm text-slate-600 max-w-2xl mx-auto">
          Apple Pay. Google Pay. Link. Card. Bank. Klarna. Afterpay. Whatever the customer already has set up — they update with one tap.{' '}
          <span className="text-slate-900 font-medium">No card numbers to retype. No friction.</span>
        </p>
      </div>

      <div className="mt-12 grid grid-cols-1 lg:grid-cols-5 gap-8 items-center">
        {/* Left rail */}
        <div className="lg:col-span-2 space-y-6">
          {RAIL_POINTS.map((p) => (
            <div key={p.title}>
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-blue-600">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-600" />
                {p.title}
              </div>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">{p.body}</p>
            </div>
          ))}
        </div>

        {/* Mockup */}
        <div className="lg:col-span-3">
          <div className="max-w-md mx-auto">
            {/* Plan context strip */}
            <div className="bg-slate-100 rounded-t-2xl px-6 pt-5 pb-4 border border-b-0 border-slate-200">
              <p className="text-sm font-semibold text-slate-900">Update payment method</p>
              <p className="mt-1.5 text-2xl font-bold text-slate-900">
                $12.00 <span className="text-sm font-normal text-slate-500">per month</span>
              </p>
              <p className="mt-1 text-xs text-slate-500">Linear Pro · Resumes immediately after update</p>
            </div>

            {/* Form card */}
            <div className="bg-white rounded-b-2xl border border-slate-200 shadow-md px-6 pt-6 pb-7">
              {/* Apple Pay + Google Pay row */}
              <div className="grid grid-cols-2 gap-2.5">
                <button type="button" className="py-3 bg-black text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-1">
                  {/* Apple logo */}
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M17.05 11.97c-.027-2.82 2.302-4.17 2.408-4.236-1.317-1.92-3.357-2.183-4.078-2.21-1.733-.18-3.387 1.02-4.27 1.02-.886 0-2.241-.998-3.687-.97-1.897.027-3.659 1.105-4.633 2.793-1.978 3.422-.504 8.473 1.41 11.244.937 1.358 2.05 2.879 3.51 2.825 1.416-.057 1.95-.91 3.66-.91 1.71 0 2.19.91 3.687.879 1.524-.027 2.488-1.385 3.42-2.747 1.077-1.575 1.519-3.103 1.546-3.18-.034-.014-2.964-1.135-2.973-4.508zm-2.78-8.282c.78-.949 1.31-2.265 1.166-3.581-1.128.046-2.504.752-3.314 1.7-.724.834-1.366 2.18-1.196 3.474 1.262.097 2.553-.642 3.344-1.593z" />
                  </svg>
                  <span className="ml-0.5">Pay</span>
                </button>
                <button type="button" className="py-3 bg-black text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5">
                  {/* Google "G" — coloured arcs */}
                  <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden>
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  <span>Pay</span>
                </button>
              </div>

              {/* Link button */}
              <button type="button" className="mt-2.5 w-full py-3 bg-emerald-500 text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-2">
                Pay faster with{' '}
                <span className="bg-black text-emerald-400 px-1.5 py-0.5 rounded font-bold tracking-tight text-xs">link</span>
              </button>

              {/* Divider */}
              <div className="flex items-center gap-3 my-5">
                <div className="flex-1 h-px bg-slate-200" />
                <p className="text-xs text-slate-500">Or pay another way</p>
                <div className="flex-1 h-px bg-slate-200" />
              </div>

              {/* Method tabs */}
              <div className="grid grid-cols-4 gap-2 mb-5">
                <button type="button" className="py-2.5 px-2 border-2 border-blue-500 bg-blue-50 rounded-lg text-xs font-semibold text-blue-700 flex flex-col items-center gap-1">
                  Card
                </button>
                <button type="button" className="py-2.5 px-2 border border-slate-200 bg-white rounded-lg text-xs font-medium text-slate-700 flex flex-col items-center gap-1">
                  Bank
                </button>
                <button type="button" className="py-2.5 px-2 border border-slate-200 bg-pink-50 rounded-lg text-xs font-semibold text-pink-700 flex items-center justify-center">
                  Klarna.
                </button>
                <button type="button" className="py-2.5 px-2 border border-slate-200 bg-emerald-50 rounded-lg text-xs font-semibold text-emerald-700 flex items-center justify-center">
                  afterpay
                </button>
              </div>

              <div>
                <span className="block text-xs font-medium text-slate-700">Email</span>
                <div className="mt-1 px-3 py-2.5 border border-slate-200 rounded-md text-sm text-slate-900">
                  sarah.chen@designstudio.co
                </div>
              </div>

              <div className="mt-3">
                <span className="block text-xs font-medium text-slate-700">Card information</span>
                <div className="mt-1 px-3 py-2.5 border border-slate-200 rounded-t-md text-sm text-slate-900 flex items-center justify-between">
                  <span className="tabular-nums">4242 4242 4242 4242</span>
                  <span className="flex gap-1 text-[10px]">
                    <span className="bg-blue-700 text-white px-1.5 py-0.5 rounded">VISA</span>
                  </span>
                </div>
                <div className="grid grid-cols-2 -mt-px">
                  <div className="px-3 py-2.5 border border-slate-200 rounded-bl-md text-sm text-slate-900 tabular-nums">12 / 28</div>
                  <div className="px-3 py-2.5 border-t border-r border-b border-slate-200 rounded-br-md text-sm text-slate-900 tabular-nums">123</div>
                </div>
              </div>

              <div className="mt-3">
                <span className="block text-xs font-medium text-slate-700">Cardholder name</span>
                <div className="mt-1 px-3 py-2.5 border border-slate-200 rounded-md text-sm text-slate-900">Sarah Chen</div>
              </div>

              <div className="mt-3">
                <span className="block text-xs font-medium text-slate-700">Country or region</span>
                <div className="mt-1 px-3 py-2.5 border border-slate-200 rounded-t-md text-sm text-slate-900">United Kingdom</div>
                <div className="px-3 py-2.5 border-x border-b border-slate-200 rounded-b-md text-sm text-slate-900 -mt-px">SW1A 1AA</div>
              </div>

              <div className="mt-5 p-4 border border-slate-200 rounded-lg flex items-start gap-3">
                <div className="mt-0.5 w-4 h-4 rounded-sm bg-indigo-600 flex items-center justify-center text-white text-[10px] flex-shrink-0">✓</div>
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    Save info for 1-click checkout with{' '}
                    <span className="bg-black text-emerald-400 px-1.5 py-0.5 rounded font-bold tracking-tight text-xs">link</span>
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Pay faster everywhere Link is accepted.</p>
                </div>
              </div>

              <button type="button" className="mt-5 w-full py-3 bg-indigo-600 text-white rounded-lg text-sm font-semibold">
                Update payment · $12.00
              </button>

              <p className="mt-4 text-center text-xs text-slate-400">
                Powered by <span className="font-semibold text-slate-500">stripe</span>
                <span className="mx-1.5">·</span> Terms <span className="mx-1">·</span> Privacy
              </p>
            </div>
          </div>
        </div>
      </div>
      </div>
    </section>
  )
}

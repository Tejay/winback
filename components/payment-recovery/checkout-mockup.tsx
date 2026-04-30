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
                <button type="button" className="py-3 bg-black text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5">
                   Pay
                </button>
                <button type="button" className="py-3 bg-black text-white rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5">
                  G Pay
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
                <div className="mt-1 px-3 py-2.5 border border-slate-200 rounded-t-md text-sm text-slate-400 flex items-center justify-between">
                  <span>1234 1234 1234 1234</span>
                  <span className="flex gap-1 text-[10px]">
                    <span className="bg-blue-700 text-white px-1.5 py-0.5 rounded">VISA</span>
                    <span className="bg-orange-500 text-white px-1.5 py-0.5 rounded">MC</span>
                    <span className="bg-blue-500 text-white px-1.5 py-0.5 rounded">AMEX</span>
                  </span>
                </div>
                <div className="grid grid-cols-2 -mt-px">
                  <div className="px-3 py-2.5 border border-slate-200 rounded-bl-md text-sm text-slate-400">MM / YY</div>
                  <div className="px-3 py-2.5 border-t border-r border-b border-slate-200 rounded-br-md text-sm text-slate-400">CVC</div>
                </div>
              </div>

              <div className="mt-3">
                <span className="block text-xs font-medium text-slate-700">Cardholder name</span>
                <div className="mt-1 px-3 py-2.5 border border-slate-200 rounded-md text-sm text-slate-400">Full name on card</div>
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

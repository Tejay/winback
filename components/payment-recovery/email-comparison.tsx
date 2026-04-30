/**
 * Section 4 — generic vs Winback email side-by-side, plus the decline-code chip row.
 * Source: marketing/payment-recovery-section.html §4. Note: no "dunning" anywhere
 * in copy (Spec 34 user instruction).
 */

const DECLINE_EXAMPLES = [
  { code: 'expired_card',           copy: '"Your card expired"' },
  { code: 'insufficient_funds',     copy: '"Wait or use a different card"' },
  { code: 'do_not_honor',           copy: '"Try a different card or call the bank"' },
  { code: 'card_velocity_exceeded', copy: '"Bank flagged the charge"' },
  { code: 'processing_error',       copy: '"No action needed"' },
]

export function EmailComparison() {
  return (
    <section className="bg-[#f5f5f5] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6">
        <div className="max-w-3xl mx-auto text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">The email</p>
        <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
          Their email. Then ours.
        </h2>
        <p className="mt-4 text-sm text-slate-600">
          Most payment-failure emails are a generic line and a raw URL. Customers gloss over them. Ours read the failure reason and tell the customer exactly what to do.
        </p>
      </div>

      <div className="mt-12 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Generic — the "before" */}
        <div className="relative">
          <div className="absolute -top-3 left-6 px-2.5 py-0.5 bg-slate-200 text-slate-600 text-[11px] font-semibold uppercase tracking-widest rounded-full">
            Generic email
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 p-6 text-sm text-slate-600 leading-relaxed shadow-sm">
            <p className="text-slate-400">From: noreply@billing.example.com</p>
            <p className="mt-2 text-slate-900 font-medium">Subject: Payment failed</p>
            <hr className="my-4 border-slate-100" />
            <p>Hi,</p>
            <p className="mt-3">We were unable to process your payment for your subscription. Please update your payment method to avoid service interruption.</p>
            <p className="mt-3 text-blue-600 underline break-all text-xs">https://billing.stripe.com/p/session/test_YWNjdF8xVEwya0VERkJtb3Z…</p>
            <p className="mt-3">Thanks.</p>
          </div>
        </div>

        {/* Winback — the "after" */}
        <div className="relative">
          <div className="absolute -top-3 left-6 px-2.5 py-0.5 bg-blue-600 text-white text-[11px] font-semibold uppercase tracking-widest rounded-full">
            Winback
          </div>
          <div className="bg-white rounded-2xl border border-blue-200 p-6 text-sm text-slate-600 leading-relaxed shadow-md">
            <p className="text-slate-400">From: Thejas &lt;noreply@winbackflow.co&gt;</p>
            <p className="mt-2 text-slate-900 font-medium">Subject: Your payment didn&apos;t go through</p>
            <hr className="my-4 border-slate-100" />
            <p className="text-[11px] font-semibold uppercase tracking-widest text-blue-600">Heads up</p>
            <p className="mt-2 text-slate-900">Hi Eve,</p>
            <p className="mt-3">We tried to charge your card for Premium Monthly ($49.00 USD) but it didn&apos;t go through.</p>

            <p className="mt-4 text-[13px] font-semibold text-slate-900">Why this happened</p>
            <p className="mt-1">Your card expired since the last successful charge.</p>

            <p className="mt-4 text-[13px] font-semibold text-slate-900">Best next step</p>
            <p className="mt-1">Update the card details (or use a different card) before our next retry.</p>

            <button
              type="button"
              className="mt-5 inline-flex items-center px-5 py-2.5 bg-[#0f172a] text-white rounded-full text-sm font-medium"
            >
              Update payment
            </button>

            <p className="mt-5">We&apos;ll try again on <span className="font-semibold">2 May</span> — updating before then means no interruption.</p>
            <p className="mt-3">If you have questions, just reply.</p>
            <p className="mt-3">— Thejas</p>
            <hr className="my-4 border-slate-100" />
            <p className="text-[11px] text-slate-400">Don&apos;t want these reminders? <a href="#" className="underline">Unsubscribe</a>.</p>
          </div>
        </div>
      </div>

        {/* Decline-code chips */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-2 text-xs text-slate-500">
          <span className="text-slate-700 font-medium">Different code, different copy:</span>
          {DECLINE_EXAMPLES.map(({ code, copy }) => (
            <span key={code} className="bg-white border border-slate-200 rounded-full px-3 py-1">
              {code} → {copy}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

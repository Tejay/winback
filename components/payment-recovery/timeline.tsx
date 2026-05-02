/**
 * Day 0 → Day 16 timeline visualisation. Source: marketing/payment-recovery-section.html §3.
 * Five points: T1 (day 0), T2 (day 2), Stripe retry #2 (day 3), T3 (day 15), final Stripe retry (day 16).
 * Our touches in solid blue; Stripe's retries in muted slate (we lead, they follow).
 */

const POINTS = [
  { day: 'Day 0',  title: 'T1 — Heads up',         body: "Stripe’s 1st attempt failed. Customer hears from you immediately, with the reason.", ours: true },
  { day: 'Day 2',  title: 'T2 — Reminder',         body: "24h before Stripe’s 2nd attempt. \"Heads up — we’ll retry tomorrow.\"", ours: true },
  { day: 'Day 3',  title: 'Stripe retry #2',       body: 'Succeeds → recovered. Fails → we keep going.', ours: false },
  { day: 'Day 15', title: 'T3 — Final reminder',   body: '24h before the last automatic retry. Urgency dialled up.', ours: true },
  { day: 'Day 16', title: "Stripe’s last try",     body: 'Then win-back kicks in if they cancel.', ours: false },
]

export function Timeline() {
  return (
    <section className="bg-white py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-5xl mx-auto px-6">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">How it works</p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900">
            Three touches, perfectly timed.
          </h2>
          <p className="mt-4 text-sm text-slate-600 leading-relaxed">
            Stripe retries the card four times across ~21 days. We sit
            ~24 hours ahead of each retry, sending the customer-facing
            email Stripe doesn&rsquo;t.{' '}
            <span className="text-slate-900 font-medium">
              Stripe handles the retry timing; we handle what the customer
              reads.
            </span>
          </p>
        </div>

        <div className="mt-12 relative">
          {/* Dotted backbone (sm and up) */}
          <div
            className="hidden sm:block absolute left-0 right-0 top-12 h-px"
            style={{ background: 'repeating-linear-gradient(to right, #cbd5e1 0 4px, transparent 4px 8px)' }}
          />

          <div className="grid grid-cols-1 sm:grid-cols-5 gap-6 relative">
            {POINTS.map((p) => {
              const dot = p.ours
                ? 'bg-blue-600 ring-blue-100'
                : 'bg-slate-300 ring-slate-100'
              const dayLabel = p.ours ? 'text-blue-600' : 'text-slate-400'
              const titleColor = p.ours ? 'text-slate-900' : 'text-slate-500'
              return (
                <div key={p.day} className="text-center">
                  <div className={`mx-auto w-6 h-6 rounded-full ring-4 relative z-10 ${dot}`} />
                  <p className={`mt-3 text-[11px] font-semibold uppercase tracking-widest ${dayLabel}`}>
                    {p.day}
                  </p>
                  <p className={`mt-1 text-sm font-medium ${titleColor}`}>{p.title}</p>
                  <p className="mt-1 text-xs text-slate-500">{p.body}</p>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}

export const metadata = { title: 'Refunds & cancellations — Winback' }

export default function RefundsPage() {
  return (
    <main className="min-h-screen bg-[#f5f5f5] py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8 prose prose-slate prose-sm max-w-none">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3 not-prose">
          Legal
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2 not-prose">
          Refunds &amp; cancellations.
        </h1>
        <p className="text-sm text-slate-500 mb-8 not-prose">
          Version 2026-04-15 · Effective 15 April 2026
        </p>

        <h2>1. When you are charged</h2>
        <p>
          Winback charges <strong>15% of monthly revenue from recovered
          subscribers, for up to 12 months per subscriber</strong>. A recovery is
          recognised only when the previously-cancelled subscriber is actively
          paying you again on Stripe.
        </p>

        <h2>2. When you are not charged</h2>
        <ul>
          <li>You are never charged until Winback has recovered a real subscriber.</li>
          <li>
            If a recovered subscriber cancels again, billing on that subscriber
            stops the same day.
          </li>
          <li>
            After 12 months per recovered subscriber, billing on that subscriber
            ends permanently.
          </li>
          <li>
            If you pause Winback, no new recoveries occur — existing attributed
            subscribers continue to bill until they cancel or hit their 12-month
            mark.
          </li>
        </ul>

        <h2>3. Cancelling Winback</h2>
        <ul>
          <li>
            Disconnect Stripe any time from Settings → Integrations, or from
            your Stripe Dashboard → Apps.
          </li>
          <li>
            Delete your Winback workspace from Settings → Danger Zone. Deletion
            is immediate and permanent (no grace period).
          </li>
          <li>
            If you delete while still inside any 12-month attribution windows,
            we quote your remaining obligation and collect it via Stripe Checkout
            before deletion completes. This is a one-time payment — no
            recurring charges after deletion.
          </li>
        </ul>

        <h2>4. Disputed charges</h2>
        <p>
          Email{' '}
          <a href="mailto:support@winbackflow.co">support@winbackflow.co</a>{' '}
          within 30 days of the invoice. We review the attribution trail in
          Stripe and respond within 5 business days. If we can&rsquo;t show a
          legitimate attribution, we credit the disputed amount.
        </p>

        <h2>5. Refunds for failed deliveries or bugs</h2>
        <p>
          If a Winback email was never sent, or was sent after the subscriber
          re-subscribed through a channel we didn&rsquo;t originate, we do not
          bill for that attribution. If we billed in error, we credit or
          refund — your choice.
        </p>

        <h2>6. Contact</h2>
        <p>
          <a href="mailto:support@winbackflow.co">support@winbackflow.co</a>
        </p>

        <hr />
        <p className="not-prose text-xs text-slate-400 mt-6">
          See also:{' '}
          <a href="/terms" className="hover:text-slate-600">Terms</a> ·{' '}
          <a href="/aup" className="hover:text-slate-600">Acceptable Use</a> ·{' '}
          <a href="/privacy" className="hover:text-slate-600">Privacy</a> ·{' '}
          <a href="/dpa" className="hover:text-slate-600">DPA</a> ·{' '}
          <a href="/contact" className="hover:text-slate-600">Contact</a>
        </p>
      </div>
    </main>
  )
}

export const metadata = { title: 'Refunds & cancellations — Winback' }

import { Footer } from '@/components/landing/footer'

export default function RefundsPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
    <main className="py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8 prose prose-slate prose-sm max-w-none">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3 not-prose">
          Legal
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2 not-prose">
          Refunds &amp; cancellations.
        </h1>
        <p className="text-sm text-slate-500 mb-8 not-prose">
          Version 2026-04-26 · Effective 26 April 2026
        </p>

        <h2>1. When you are charged</h2>
        <p>
          Winback charges in two parts:
        </p>
        <ul>
          <li>
            <strong>Platform fee — $99 per month</strong>, billed as a recurring
            Stripe Subscription. Starts when we deliver your first payment
            recovery or win-back, whichever comes first; the first cycle is
            prorated to that date. Covers the platform itself plus up to 500
            payment recoveries per month.
          </li>
          <li>
            <strong>Performance fee — one month of the recovered subscriber&rsquo;s
            MRR</strong>, charged once per win-back. A win-back is when a
            previously-cancelled subscriber clicks the reactivate link in our
            email and resumes paying you on Stripe. The fee is added as an
            invoice item to the relevant Stripe Subscription cycle.
          </li>
        </ul>

        <h2>2. When you are not charged</h2>
        <ul>
          <li>
            <strong>Until first delivery.</strong> You pay nothing until Winback
            has actually delivered a payment recovery or a win-back. If neither
            happens, no platform fee is ever billed.
          </li>
          <li>
            <strong>Payment recoveries do not incur a per-recovery fee.</strong>{' '}
            The flat $99/mo includes up to 500 payment recoveries per month —
            no incremental charge per recovery within that allowance.
          </li>
          <li>
            <strong>Stripe&rsquo;s own retries.</strong> If a failed payment is
            recovered by Stripe&rsquo;s built-in retries with no email from us
            and no card update by the customer, we don&rsquo;t record a recovery
            and you are not billed for it.
          </li>
          <li>
            <strong>Weak-attribution win-backs are not billed.</strong> If a
            cancelled subscriber resubscribes without clicking our reactivate
            link, the recovery shows on your dashboard but no performance fee is
            charged.
          </li>
        </ul>

        <h2>3. 14-day refund window for win-back fees</h2>
        <p>
          If a subscriber we won back cancels again <strong>within 14 days</strong>{' '}
          of the recovery, we refund the entire performance fee for that
          recovery. The refund is automatic when we detect the re-cancellation:
          if the fee was on a not-yet-finalized invoice, the line item is
          removed before the invoice bills; if the invoice has already been
          paid, we issue a Stripe credit note for the full amount.
        </p>
        <p>
          After 14 days the fee stands — that subscriber had a real period of
          paid revenue and the recovery counted.
        </p>

        <h2>4. Cancelling Winback</h2>
        <ul>
          <li>
            <strong>Pause anytime</strong> from Settings — your data stays
            intact, no new emails go out, and the platform subscription
            continues to run in the background. You can resume any time.
          </li>
          <li>
            <strong>Cancel the subscription</strong> from Settings → Billing
            (cancels at the end of the current cycle, no more charges
            thereafter). Your data remains for as long as the workspace exists.
          </li>
          <li>
            <strong>Disconnect Stripe</strong> any time from Settings →
            Integrations or from your Stripe Dashboard → Apps. New
            cancellations will no longer be detected.
          </li>
          <li>
            <strong>Delete your workspace</strong> from Settings → Danger Zone.
            Deletion is immediate and permanent (no grace period). If a platform
            subscription is active at deletion, we cancel it immediately and
            Stripe issues a prorated final invoice for the unused portion of
            the current cycle. There is no settlement obligation for past
            recoveries.
          </li>
        </ul>

        <h2>5. Disputed charges</h2>
        <p>
          Email{' '}
          <a href="mailto:support@winbackflow.co">support@winbackflow.co</a>{' '}
          within 30 days of the invoice. We review the recovery&rsquo;s
          attribution trail (the tracked email click that triggered the fee)
          and respond within 5 business days. If we can&rsquo;t show a
          legitimate trigger, we credit or refund the disputed amount.
        </p>

        <h2>6. Refunds for failed deliveries or bugs</h2>
        <p>
          If a Winback email was never sent, or was sent in error, we don&rsquo;t
          bill the related performance fee. If we billed in error, we credit or
          refund — your choice.
        </p>

        <h2>7. Contact</h2>
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
    <Footer />
    </div>
  )
}

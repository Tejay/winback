export const metadata = { title: 'Refunds & cancellations — Winback' }

import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'

export default function RefundsPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
    <StickyNav />
    <main className="py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8 prose prose-slate prose-sm max-w-none">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3 not-prose">
          Legal
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2 not-prose">
          Refunds &amp; cancellations.
        </h1>
        <p className="text-sm text-slate-500 mb-8 not-prose">
          Version 2026-05-23 · Effective 23 May 2026
        </p>

        <h2>1. When you are charged</h2>
        <p>
          WinbackFlow bills a single flat monthly fee priced by your own MRR,
          paid as a recurring Stripe Subscription on our platform Stripe
          account. There are no per-recovery charges, no performance fees, and
          no usage overages.
        </p>
        <ul>
          <li>
            <strong>Starter</strong> &mdash; MRR up to $50k &mdash; $99 / month
          </li>
          <li>
            <strong>Growth</strong> &mdash; MRR $50k – $250k &mdash; $299 / month
          </li>
          <li>
            <strong>Scale</strong> &mdash; MRR $250k – $1M &mdash; $699 / month
          </li>
          <li>
            <strong>Enterprise</strong> &mdash; MRR $1M+ &mdash; custom,
            sales-handled
          </li>
        </ul>
        <p>
          Your tier is computed from your own Stripe account (read via
          Stripe Connect &mdash; no self-reporting). The activation page
          shows you the math before you confirm: your MRR, the resulting
          tier, and the monthly fee. You click Subscribe at the displayed
          price &mdash; we never auto-charge a tier you didn&rsquo;t confirm.
        </p>

        <h2>2. When you are not charged</h2>
        <ul>
          <li>
            <strong>Until first delivery.</strong> You pay nothing until
            WinbackFlow has actually delivered a payment recovery or a
            win-back. Until then the platform runs for free.
          </li>
          <li>
            <strong>No per-recovery charges.</strong> The flat tier fee
            covers unlimited recovery volume &mdash; both win-backs and
            payment recoveries, however many of each.
          </li>
          <li>
            <strong>Enterprise tier is never auto-charged.</strong> Accounts
            whose MRR exceeds $1M are routed to sales; pricing is bespoke
            and only takes effect once a contract is signed.
          </li>
        </ul>

        <h2>3. Tier changes</h2>
        <p>
          We never auto-change your billed tier. If your MRR grows into a
          higher band, you&rsquo;ll see an upgrade prompt in your dashboard
          and settings &mdash; click to switch, ignore to stay on your
          current plan. Same for downgrades: if your MRR drops, you&rsquo;ll
          see a downgrade option, never an automatic price change.
        </p>
        <p>
          When you do switch tiers through the in-app prompt or the Stripe
          Customer Portal, the new price takes effect on your next billing
          cycle with normal Stripe proration.
        </p>

        <h2>4. Cancelling Winback</h2>
        <ul>
          <li>
            <strong>Pause anytime</strong> from Settings &mdash; your data
            stays intact, no new emails go out, and the platform subscription
            continues to run in the background. You can resume any time.
          </li>
          <li>
            <strong>Cancel the subscription</strong> from Settings &rarr;
            Billing (cancels at the end of the current cycle, no more charges
            thereafter). Your data remains for as long as the workspace exists.
            Recovery and win-back machinery continues to run on your account
            for free &mdash; the next delivered recovery will prompt you to
            re-subscribe at your then-current MRR tier.
          </li>
          <li>
            <strong>Disconnect Stripe</strong> any time from Settings &rarr;
            Integrations or from your Stripe Dashboard &rarr; Apps. New
            cancellations will no longer be detected.
          </li>
          <li>
            <strong>Delete your workspace</strong> from Settings &rarr; Danger
            Zone. Deletion is immediate and permanent (no grace period). If
            a platform subscription is active at deletion, we cancel it
            immediately and Stripe issues a prorated final invoice for the
            unused portion of the current cycle.
          </li>
        </ul>

        <h2>5. Disputed charges</h2>
        <p>
          Email{' '}
          <a href="mailto:support@winbackflow.co">support@winbackflow.co</a>{' '}
          within 30 days of the invoice. We review the tier assignment math
          (the MRR snapshot taken at activation and the recurring snapshots
          since) and respond within 5 business days. If we can&rsquo;t justify
          the tier you were billed at, we credit or refund the disputed
          amount.
        </p>

        <h2>6. Refunds for billing errors</h2>
        <p>
          If we billed you at the wrong tier (e.g. our MRR computation was
          off by enough to cross a band), we credit or refund the difference
          &mdash; your choice. We never round in our favor; the spec is to
          bias-low on band edges.
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

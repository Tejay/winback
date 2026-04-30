import { Footer } from '@/components/landing/footer'

export const metadata = { title: 'Privacy Policy — Winback' }

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
    <main className="py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8 prose prose-slate prose-sm max-w-none">
        {/* LAWYER REVIEW BEFORE LAUNCH — draft based on public privacy policies of Churnkey, Stunning, Retainful, and ProfitWell. */}
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3 not-prose">
          Legal
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2 not-prose">Privacy Policy.</h1>
        <p className="text-sm text-slate-500 mb-8 not-prose">Version 2026-04-14 · Effective 14 April 2026</p>

        <h2>1. Who we are</h2>
        <p>
          Winback (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is operated by Axiomis OÜ trading as
          Winback, a company registered in Estonia. Our service helps subscription businesses
          re-engage customers who have cancelled. You can reach us at{' '}
          <a href="mailto:privacy@winbackflow.co">privacy@winbackflow.co</a>.
        </p>

        <h2>2. Our role</h2>
        <p>
          When you sign up as a customer of Winback, we act as a{' '}
          <strong>data controller</strong> for your account data (name, email, company,
          billing). When we process the personal data of your churned subscribers on
          your behalf, we act as a <strong>data processor</strong> under our{' '}
          <a href="/dpa">Data Processing Agreement</a>.
        </p>

        <h2>3. What we collect</h2>
        <p>For our customers (controllers):</p>
        <ul>
          <li>Account data: name, work email, hashed password, IP address at signup.</li>
          <li>Billing data: Stripe customer ID, subscription status, invoices.</li>
          <li>Configuration: Stripe OAuth token (encrypted), product changelog text.</li>
        </ul>
        <p>For churned subscribers (data subjects we process on behalf of our customers):</p>
        <ul>
          <li>Identifiers: email address, first name (if available), Stripe customer ID.</li>
          <li>Subscription metadata: plan, MRR, tenure, cancellation reason code/comment.</li>
          <li>Reply content if the subscriber responds to a re-engagement email.</li>
        </ul>

        <h2>4. Lawful basis</h2>
        <p>
          For our own customer relationship, we rely on <strong>contract</strong>{' '}
          (Art. 6(1)(b) GDPR). For processing churned-subscriber data on behalf of our
          customers, our customers rely on <strong>legitimate interest</strong>{' '}
          (Art. 6(1)(f)) — re-engaging a recently lapsed customer with whom they had an
          existing relationship. Subscribers can opt out at any time via the unsubscribe
          link in every email.
        </p>

        <h2>5. How we use data</h2>
        <p>
          To classify cancellation reasons, generate personalised win-back emails, send
          those emails via Resend, handle one-click unsubscribes, match future product
          updates back to interested subscribers, and bill customers based on recovered MRR.
        </p>

        <h2>6. Automated decision-making (Art. 22)</h2>
        <p>
          We use Anthropic&rsquo;s Claude model to classify cancellation reasons and draft
          email copy. This is <strong>not</strong> a decision producing legal or similarly
          significant effects — the output is a marketing email a human can ignore or
          unsubscribe from. Our customer reviews and may edit every message before it is
          sent. We run Claude in zero-retention mode: Anthropic does not store the
          inputs or outputs.
        </p>

        <h2>7. Subprocessors</h2>
        <p>
          We use a small number of vetted subprocessors (Vercel, Neon, Anthropic,
          Resend, Stripe). See the live list at <a href="/subprocessors">/subprocessors</a>.
        </p>

        <h2>8. International transfers</h2>
        <p>
          Our subprocessors are primarily based in the United States. Transfers rely on
          the European Commission&rsquo;s Standard Contractual Clauses (2021/914) and
          supplementary measures where applicable.
        </p>

        <h2>9. Retention</h2>
        <p>
          Subscriber records are retained for up to <strong>2 years</strong> after
          cancellation, then deleted. See <a href="/terms">Terms</a> and our internal
          retention policy. Customers may request shorter retention for their account.
        </p>

        <h2>10. Your rights</h2>
        <p>
          You have the right to access, rectify, erase, restrict, port, and object to
          processing of your personal data, and to lodge a complaint with your data
          protection authority. To exercise any of these rights, email{' '}
          <a href="mailto:privacy@winbackflow.co">privacy@winbackflow.co</a>. We respond
          within 30 days.
        </p>

        <h2>11. Security</h2>
        <p>
          Data is encrypted in transit (TLS 1.2+) and at rest. Stripe OAuth tokens are
          encrypted with AES-128-GCM. Access to production systems is restricted to the
          founding team and audited.
        </p>

        <h2>12. Changes</h2>
        <p>
          If we materially update this policy, we will notify active customers by email
          at least 30 days before the change takes effect.
        </p>
      </div>
    </main>
    <Footer />
    </div>
  )
}

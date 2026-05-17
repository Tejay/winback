import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'

export const metadata = { title: 'Privacy Policy — Winback' }

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
    <StickyNav />
    <main className="py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8 prose prose-slate prose-sm max-w-none">
        {/* LAWYER REVIEW BEFORE LAUNCH — draft based on public privacy policies of Churnkey, Stunning, Retainful, and ProfitWell. */}
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3 not-prose">
          Legal
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2 not-prose">Privacy Policy.</h1>
        <p className="text-sm text-slate-500 mb-8 not-prose">Version 2026-05-17 · Effective 17 May 2026</p>

        <h2>1. Who we are</h2>
        <p>
          Winback (&ldquo;we&rdquo;, &ldquo;us&rdquo;) is operated by{' '}
          <strong>Axiomis OÜ trading as Winback</strong>, a company
          registered in Estonia under <strong>commercial registry
          number 17493372</strong>, with registered office at{' '}
          <strong>Sepapaja tn 6, 15551 Tallinn, Estonia</strong>. Our
          service helps subscription businesses recover lost revenue
          from two sources: <strong>payment failures</strong>
          (subscriptions cancelled by Stripe after a card decline) and
          <strong> deliberate cancellations</strong> (subscribers who
          chose to leave). You can reach us at{' '}
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
        <p>For your subscribers (data subjects we process on behalf of our customers):</p>
        <ul>
          <li>Identifiers: email address, first name (if available), Stripe customer ID.</li>
          <li>Subscription metadata: plan, MRR, tenure, status (active / cancelled / past-due).</li>
          <li>
            For deliberate cancellations: cancellation reason code and any
            free-text comment the subscriber provided to your cancel flow.
          </li>
          <li>
            For payment failures: the Stripe decline code (e.g. expired
            card, insufficient funds), the timestamp of each retry attempt,
            and the timestamp the card was successfully updated.
          </li>
          <li>Reply content if the subscriber responds to one of our emails.</li>
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
        <p>We process your subscribers&rsquo; personal data for these specific purposes:</p>
        <ul>
          <li>
            <strong>Payment-recovery emails.</strong> When a card
            payment fails, send a short decline-code-aware sequence
            (typically up to three messages, timed to lead Stripe&rsquo;s
            automatic retries) with a one-tap link to update the
            payment method. These emails are rule-based and not
            AI-drafted.
          </li>
          <li>
            <strong>Cancellation classification and win-back emails.</strong>{' '}
            Classify the cancellation reason using Anthropic&rsquo;s
            Claude model, draft a personalised reply in your approved
            voice, and send it via Resend.
          </li>
          <li>
            <strong>Re-engagement when you ship something.</strong>{' '}
            When you publish a product improvement in your dashboard,
            match it against past cancellation reasons from the last
            12 months and send one targeted email to subscribers whose
            stated reason matches what you just shipped.
          </li>
          <li>
            <strong>Handle inbound replies, unsubscribes, and DSRs.</strong>{' '}
            Capture replies for your dashboard, honour one-click
            unsubscribes immediately, and process data-subject
            requests received via the controllers we serve.
          </li>
          <li>
            <strong>Billing our customers.</strong> Charge a flat
            $99/mo platform fee and a one-time fee equal to one month
            of the won-back subscriber&rsquo;s subscription fee for
            each delivered cancellation win-back (refundable if the
            subscriber re-cancels within 14 days).
          </li>
        </ul>

        <h2>6. Automated decision-making (Art. 22)</h2>
        <p>
          We use Anthropic&rsquo;s Claude model to classify
          cancellation reasons, cluster recurring themes across recent
          cancellations, and draft cancellation-winback emails. This
          processing is <strong>not</strong> a decision producing legal
          or similarly significant effects on the subscriber &mdash;
          the output is an email the subscriber can ignore or
          unsubscribe from in one click.
        </p>
        <p>
          The Winback customer approves the email tone, voice, and
          template structure during onboarding. After that, individual
          cancellation-winback emails are sent automatically (typically
          within about one minute of the cancellation event) without
          per-message human review. The Winback customer can pause
          sending at any time from Settings, edit the template, or
          handle an individual subscriber themselves. Payment-recovery
          emails are not AI-drafted: they are rule-based decline-aware
          copy with no per-message AI involvement.
        </p>
        <p>
          We run Claude in zero-retention mode: Anthropic does not
          store the inputs or outputs after the request completes, and
          does not use them to train models.
        </p>

        <h2>7. Subprocessors</h2>
        <p>
          We use a small number of vetted subprocessors (Vercel, Neon, Anthropic,
          Resend, Stripe). See the live list at <a href="/subprocessors">/subprocessors</a>.
        </p>

        <h2>8. International transfers</h2>
        <p>
          We are established in the European Economic Area (Estonia), and core
          processing happens within the EEA. Some of our subprocessors
          (Anthropic, Resend, and parts of Stripe) are based in the United
          States. Transfers to those subprocessors rely on the European
          Commission&rsquo;s Standard Contractual Clauses (Implementing Decision
          (EU) 2021/914), incorporated into our Data Processing Agreement, plus
          supplementary technical measures (TLS 1.2+ in transit, AES-128-GCM at
          rest for sensitive secrets, and least-privilege access controls).
        </p>

        <h2>9. Retention</h2>
        <p>
          We retain subscriber records for as long as the Winback
          customer&rsquo;s workspace exists, so that performance
          metrics (recovered subscribers, revenue saved) remain
          accurate over time. When a customer deletes their Winback
          workspace, we delete the associated subscriber data within
          30 days, subject to retention obligations under applicable
          law. Customers can request earlier deletion of specific
          subscriber records at any time by emailing{' '}
          <a href="mailto:privacy@winbackflow.co">privacy@winbackflow.co</a>.
        </p>
        <p>
          Account data (your name, login email, billing records) is
          retained for the duration of the customer relationship plus
          the period required for tax, accounting, and dispute
          obligations under Estonian law (typically 7 years for
          accounting records).
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

        <h2>12. Cookies</h2>
        <p>
          We use only <strong>essential cookies</strong> required to
          keep you signed in (a session cookie set by our auth library)
          and to remember the dashboard tab you last opened. We do not
          set advertising, analytics, or third-party tracking cookies.
          You do not need to accept a cookie banner to use the
          Service.
        </p>

        <h2>13. California residents (CCPA / CPRA)</h2>
        <p>
          If you are a California resident, you have the right to know
          what personal information we collect about you, to access or
          delete it, to correct inaccuracies, and to opt out of any
          &ldquo;sale&rdquo; or &ldquo;sharing&rdquo; of personal
          information for cross-context behavioural advertising.
          We do not sell or share personal information for such
          purposes &mdash; the data we process is used solely to
          deliver the Winback Service to you or to the Winback
          customer who controls your data. To exercise any of these
          rights, email{' '}
          <a href="mailto:privacy@winbackflow.co">privacy@winbackflow.co</a>.
        </p>

        <h2>14. Children&rsquo;s privacy</h2>
        <p>
          Winback is a business-to-business service intended for use
          by subscription businesses and their adult subscribers. The
          Service is not directed to children under 16 and we do not
          knowingly collect personal information from anyone under 16.
          If you believe we have inadvertently collected personal data
          from a minor, email{' '}
          <a href="mailto:privacy@winbackflow.co">privacy@winbackflow.co</a>
          {' '}and we will delete it.
        </p>

        <h2>15. Changes</h2>
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

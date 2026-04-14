export const metadata = { title: 'Terms of Service — Winback' }

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#f5f5f5] py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8 prose prose-slate prose-sm max-w-none">
        {/* LAWYER REVIEW BEFORE LAUNCH — boilerplate modelled on Churnkey and Retainful public terms. */}
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3 not-prose">
          Legal
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2 not-prose">Terms of Service.</h1>
        <p className="text-sm text-slate-500 mb-8 not-prose">Version 2026-04-14 · Effective 14 April 2026</p>

        <h2>1. Agreement</h2>
        <p>
          These Terms govern your use of Winback (the &ldquo;Service&rdquo;), operated
          by Winback Ltd (&ldquo;we&rdquo;). By creating an account you agree to these
          Terms, our <a href="/privacy">Privacy Policy</a>, and our{' '}
          <a href="/dpa">Data Processing Agreement</a>.
        </p>

        <h2>2. The Service</h2>
        <p>
          Winback connects to your Stripe account, detects cancelled subscribers, and
          sends personalised re-engagement emails on your behalf. You are responsible
          for the content and targeting of those emails.
        </p>

        <h2>3. Fees</h2>
        <p>
          The Service is free until your first recovered subscriber. After that, the
          fee is <strong>£49/month</strong> plus <strong>10%</strong> of recovered MRR
          for the first 12 months each subscriber remains reactivated. Fees are billed
          monthly in arrears via Stripe. All fees are exclusive of VAT.
        </p>

        <h2>4. Your responsibilities</h2>
        <ul>
          <li>You have the legal basis (typically legitimate interest) to contact your own churned subscribers.</li>
          <li>You will honour unsubscribe requests and will not circumvent the unsubscribe mechanism.</li>
          <li>You will not use the Service for cold outreach, purchased lists, or recipients who have not had a subscription with you.</li>
          <li>You will keep your Stripe credentials secure.</li>
        </ul>

        <h2>5. Acceptable use</h2>
        <p>
          You may not use the Service to send unlawful, deceptive, or harassing content,
          to violate any third party&rsquo;s rights, or to disrupt the integrity of the
          Service. We may suspend accounts that breach these Terms.
        </p>

        <h2>6. Intellectual property</h2>
        <p>
          We own the Service. You own your data. You grant us a limited licence to
          process your data solely to provide the Service, as described in the DPA.
        </p>

        <h2>7. Warranties</h2>
        <p>
          The Service is provided &ldquo;as is&rdquo;. We do not guarantee specific
          recovery rates. To the maximum extent permitted by law, we disclaim all
          implied warranties.
        </p>

        <h2>8. Limitation of liability</h2>
        <p>
          Our total liability for any claim arising out of these Terms is capped at the
          greater of (a) £100 or (b) the fees you paid us in the 12 months preceding the
          claim. We are not liable for indirect, incidental, or consequential damages.
        </p>

        <h2>9. Termination</h2>
        <p>
          You may cancel at any time from Settings. We may terminate for breach on 30
          days&rsquo; notice. On termination we delete your data within 30 days, subject
          to retention obligations.
        </p>

        <h2>10. Governing law</h2>
        <p>
          These Terms are governed by the laws of England and Wales. Disputes are
          subject to the exclusive jurisdiction of the courts of England and Wales.
        </p>

        <h2>11. Changes</h2>
        <p>
          We may update these Terms. Material changes will be notified by email at
          least 30 days in advance.
        </p>

        <h2>12. Contact</h2>
        <p>
          <a href="mailto:privacy@winbackflow.co">privacy@winbackflow.co</a>
        </p>
      </div>
    </main>
  )
}

export const metadata = { title: 'Data Processing Agreement — Winback' }

import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'

export default function DpaPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
    <StickyNav />
    <main className="py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8 prose prose-slate prose-sm max-w-none">
        {/* LAWYER REVIEW BEFORE LAUNCH — modelled on Stunning and ProfitWell public DPAs. SCCs appendix to be attached. */}
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3 not-prose">
          Legal
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2 not-prose">Data Processing Agreement.</h1>
        <p className="text-sm text-slate-500 mb-8 not-prose">Version 2026-04-14 · Effective 14 April 2026</p>

        <p>
          This Data Processing Agreement (&ldquo;DPA&rdquo;) forms part of the
          <a href="/terms"> Terms of Service</a> between Axiomis OÜ trading as Winback (&ldquo;Processor&rdquo;)
          and the Winback customer (&ldquo;Controller&rdquo;). It reflects the
          parties&rsquo; agreement on the processing of personal data of the
          Controller&rsquo;s churned subscribers (&ldquo;Data Subjects&rdquo;) in
          accordance with Article 28 of Regulation (EU) 2016/679 (the EU General
          Data Protection Regulation, &ldquo;GDPR&rdquo;).
        </p>

        <h2>1. Subject matter &amp; duration</h2>
        <p>
          The subject matter is the provision of the Winback Service. Duration matches
          the duration of the main agreement.
        </p>

        <h2>2. Nature &amp; purpose of processing</h2>
        <p>
          Classifying cancellation reasons, generating and sending re-engagement emails,
          recording replies and opt-outs, and reporting on recoveries.
        </p>

        <h2>3. Categories of data subjects and personal data</h2>
        <ul>
          <li>Data subjects: the Controller&rsquo;s churned paying subscribers.</li>
          <li>Categories: email address, first name (optional), Stripe customer ID, subscription metadata, cancellation reason, reply content.</li>
          <li>No special category data is intentionally processed.</li>
        </ul>

        <h2>4. Processor obligations</h2>
        <ul>
          <li>Process personal data only on documented instructions from the Controller, including as set out in the Service configuration.</li>
          <li>Ensure that personnel with access are bound by confidentiality obligations.</li>
          <li>Implement appropriate technical and organisational measures (see §8).</li>
          <li>Assist the Controller in responding to data subject requests (access, erasure, portability) within reasonable timeframes.</li>
          <li>Notify the Controller without undue delay (within 72 hours) of becoming aware of a personal data breach.</li>
          <li>At the Controller&rsquo;s choice, delete or return all personal data at the end of the agreement, subject to legal retention obligations.</li>
          <li>Make available all information necessary to demonstrate compliance and allow for audits (with 30 days&rsquo; notice, no more than once per year, under NDA).</li>
        </ul>

        <h2>5. Subprocessors</h2>
        <p>
          The Controller provides general authorisation for the Processor to engage
          subprocessors listed at <a href="/subprocessors">/subprocessors</a>. The
          Processor will notify the Controller of additions or replacements at least
          30 days before they take effect; the Controller may object on reasonable
          grounds. The Processor remains liable for its subprocessors&rsquo; acts.
        </p>

        <h2>6. International transfers</h2>
        <p>
          The Processor is established in the European Economic Area (Estonia).
          Where the Processor or one of its subprocessors transfers personal
          data outside the EEA, the parties rely on the European
          Commission&rsquo;s Standard Contractual Clauses (Implementing Decision
          (EU) 2021/914), incorporated into this DPA by reference. Module Two
          (Controller-to-Processor) applies between Controller and Processor;
          Module Three (Processor-to-Processor) applies where a subprocessor
          acts as a further processor on behalf of the Processor. The Processor
          implements supplementary technical measures including TLS 1.2+ in
          transit, AES-128-GCM at rest for sensitive secrets, and role-based
          access controls (see §8).
        </p>

        <h2>7. Data subject rights</h2>
        <p>
          The Processor will, taking into account the nature of the processing,
          assist the Controller by appropriate technical and organisational
          measures (including the unsubscribe mechanism, subscriber data export,
          and DSR tooling) to respond to requests under Chapter III of the
          GDPR. The Processor responds to forwarded data subject requests
          within the timeframes set out in Article 12 GDPR.
        </p>

        <h2>8. Security measures</h2>
        <ul>
          <li>Encryption in transit (TLS 1.2+) and at rest.</li>
          <li>AES-128-GCM encryption of sensitive secrets (e.g. Stripe OAuth tokens).</li>
          <li>Role-based access control; production access restricted to founders.</li>
          <li>Hosted on audited providers (Vercel, Neon) with their own SOC 2 attestations.</li>
          <li>Secure software development: code review, automated tests, dependency scanning.</li>
          <li>Backups retained for 7 days and deleted thereafter.</li>
        </ul>

        <h2>9. Liability</h2>
        <p>
          Liability under this DPA is subject to the limitation of liability in the main
          Terms. Nothing in this DPA excludes liability that cannot be excluded under
          applicable data protection law.
        </p>

        <h2>10. Order of precedence</h2>
        <p>
          In the event of conflict, the SCCs prevail over this DPA, and this DPA
          prevails over the main Terms with respect to personal data processing.
        </p>

        <h2>Appendix A — SCCs</h2>
        <p>
          The Standard Contractual Clauses (Implementing Decision (EU)
          2021/914) are incorporated by reference. Annex I (parties and
          description of transfer) is populated with the parties identified in
          this DPA and the categories of data and data subjects in §3. Annex II
          (technical and organisational measures) is populated with the
          measures in §8. Annex III (list of subprocessors) is published at{' '}
          <a href="/subprocessors">/subprocessors</a> and updated in line with §5.
        </p>

        <h2>Contact</h2>
        <p>
          <a href="mailto:privacy@winbackflow.co">privacy@winbackflow.co</a>
        </p>
      </div>
    </main>
    <Footer />
    </div>
  )
}

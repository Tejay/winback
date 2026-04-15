export const metadata = { title: 'Acceptable Use Policy — Winback' }

export default function AupPage() {
  return (
    <main className="min-h-screen bg-[#f5f5f5] py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8 prose prose-slate prose-sm max-w-none">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3 not-prose">
          Legal
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2 not-prose">
          Acceptable Use Policy.
        </h1>
        <p className="text-sm text-slate-500 mb-8 not-prose">
          Version 2026-04-15 · Effective 15 April 2026
        </p>

        <p>
          This policy governs what Winback customers (&ldquo;you&rdquo;) may and
          may not do with the Winback service. Breach of this policy is grounds
          for immediate account suspension without refund, and — where legal
          thresholds are crossed — reporting to the relevant authorities.
        </p>

        <h2>What Winback is for</h2>
        <p>
          Sending a personalised, one-time win-back email from your
          business&rsquo;s real identity to a subscriber who cancelled a paid
          subscription with you on Stripe. The email must be relevant to the
          cancelled subscription and must carry your return-route reply
          address.
        </p>

        <h2>What you must not do</h2>
        <ul>
          <li>
            <strong>Spam.</strong> Winback sends one email per cancellation.
            You may not use Winback&rsquo;s sending domain to send bulk
            broadcasts, newsletters, sequences, promotions, or any message to
            subscribers who did not cancel a subscription with you through
            Stripe.
          </li>
          <li>
            <strong>Scraped or purchased lists.</strong> The only legitimate
            input to Winback is a Stripe cancellation event you received
            through your own, consented customer relationship. Importing
            addresses from any other source is a terminating breach.
          </li>
          <li>
            <strong>Pretending to be someone else.</strong> The &ldquo;From&rdquo;
            name in a win-back email must be a real person at your business.
            You may not impersonate a third party, a Stripe employee, or
            Winback itself.
          </li>
          <li>
            <strong>Sending to unsubscribers.</strong> Every Winback email
            carries <code>List-Unsubscribe</code> plus a visible link.
            Unsubscribes are honoured automatically within seconds. You may
            not circumvent, disable, or override this.
          </li>
          <li>
            <strong>Illegal, harmful, or hateful content.</strong> The standard
            prohibitions: content that is unlawful, threatens or harasses a
            person, sexualises minors, incites violence, or facilitates fraud,
            money laundering, unlicensed gambling, unlicensed financial
            services, weapons trafficking, illegal drugs, CSAM, or terrorism.
          </li>
          <li>
            <strong>Regulated industries without compliance.</strong>{' '}
            Healthcare and financial services subscriptions may use Winback
            only if your own compliance obligations allow automated email
            follow-up at the moment of cancellation.
          </li>
          <li>
            <strong>Abusing Stripe.</strong> You may not use Winback to
            automate refunds, create subscriptions without the
            subscriber&rsquo;s click-through, bypass Stripe&rsquo;s own terms,
            or disguise the origin of a charge.
          </li>
          <li>
            <strong>Sharing credentials.</strong> Your Stripe OAuth connection,
            Winback login, and API tokens are personal to your business. You
            may not share them.
          </li>
        </ul>

        <h2>Spam-complaint thresholds</h2>
        <p>
          We monitor complaint rate on our sending domain. If complaints from a
          single Winback customer exceed <strong>0.3% of messages sent</strong>{' '}
          over a rolling 7-day window, we automatically pause sending for that
          customer and email the founder. Repeat breaches end in termination.
        </p>

        <h2>Reporting abuse</h2>
        <p>
          If you believe Winback is being used against you or against a
          subscriber — including as a recipient of a Winback email that looks
          like spam — email{' '}
          <a href="mailto:abuse@winbackflow.co">abuse@winbackflow.co</a>. We
          triage within 1 business day.
        </p>

        <h2>Enforcement</h2>
        <p>Breach of this policy is grounds to:</p>
        <ol>
          <li>Pause your Winback account immediately;</li>
          <li>
            Terminate your Winback account with no refund for the current
            billing period;
          </li>
          <li>
            Report to the ICO (UK), relevant DPA (EU), Stripe, or law
            enforcement where required.
          </li>
        </ol>
        <p>
          We will tell you why we took action, unless legally prevented from
          doing so.
        </p>

        <h2>Changes</h2>
        <p>
          We update this policy as abuse vectors change. Material changes are
          emailed to account owners 14 days before they take effect, except for
          changes that address an active abuse incident — those take effect
          immediately.
        </p>

        <hr />
        <p className="not-prose text-xs text-slate-400 mt-6">
          See also:{' '}
          <a href="/terms" className="hover:text-slate-600">Terms</a> ·{' '}
          <a href="/refunds" className="hover:text-slate-600">Refunds</a> ·{' '}
          <a href="/privacy" className="hover:text-slate-600">Privacy</a> ·{' '}
          <a href="/dpa" className="hover:text-slate-600">DPA</a> ·{' '}
          <a href="/contact" className="hover:text-slate-600">Contact</a>
        </p>
      </div>
    </main>
  )
}

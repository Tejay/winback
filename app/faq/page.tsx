import Link from 'next/link'

export const metadata = {
  title: 'FAQ — Winback',
  description:
    'Stripe access, customer experience, pricing, and GDPR — answered.',
}

interface QA {
  q: string
  a: React.ReactNode
}

const SECTIONS: Array<{ heading: string; items: QA[] }> = [
  {
    heading: 'Stripe access & your data',
    items: [
      {
        q: 'What access does Winback have to my Stripe account?',
        a: (
          <>
            <p>
              We connect via Stripe&rsquo;s standard OAuth flow. Stripe shows
              you the exact permissions on the consent screen before you
              approve. We <em>read</em> your customers, subscriptions, and
              cancellation events &mdash; that&rsquo;s how we detect churn and
              attribute recoveries. We use <em>write</em> access for one
              purpose only: renewing or reactivating a subscription on your
              behalf when a customer accepts a win-back offer, so they can
              restart in a single click without re-entering card details. We
              never create new subscriptions out of nowhere, never refund,
              never change prices. You can disconnect us any time from your
              Stripe Dashboard &rarr; Settings &rarr; Apps.
            </p>
            <p className="mt-3 text-slate-500 italic">
              Prefer not to grant write access? A read-only API-key flow is on
              our roadmap &mdash; email us if you&rsquo;d like early access.
            </p>
          </>
        ),
      },
      {
        q: 'Can Winback charge my customers or change my prices?',
        a: (
          <p>
            No. We never create charges, never issue refunds, never change
            prices or plan configurations. The only &ldquo;write&rdquo; action
            we take is renewing a cancelled subscription when a customer
            clicks your win-back offer &mdash; and that only restores what
            they previously had.
          </p>
        ),
      },
      {
        q: 'What happens if I disconnect Stripe?',
        a: (
          <p>
            We stop receiving cancellation events immediately and stop sending
            win-back emails. Nothing on your Stripe side changes &mdash; your
            subscriptions, customers, and prices are untouched.
          </p>
        ),
      },
      {
        q: 'Where is my data stored?',
        a: (
          <p>
            On servers in the US (AWS us-east-2), under EU Standard
            Contractual Clauses. The full list of subprocessors, what each one
            processes, and their locations is published at{' '}
            <Link href="/subprocessors" className="text-blue-600 hover:underline">
              /subprocessors
            </Link>
            .
          </p>
        ),
      },
      {
        q: 'Do you use my subscribers\u2019 data to train AI?',
        a: (
          <p>
            No. The AI we use to understand cancellation reasons runs in
            zero-retention mode &mdash; your subscribers&rsquo; data is not
            stored by the AI provider after the request completes, and is
            never used to train models.
          </p>
        ),
      },
    ],
  },
  {
    heading: 'How the emails work',
    items: [
      {
        q: 'Who does the email come from?',
        a: (
          <p>
            It&rsquo;s sent with your name on the &ldquo;From&rdquo; line
            (e.g., <em>Alex Smith &lt;reply+&hellip;@winbackflow.co&gt;</em>)
            from our sending domain. When a subscriber replies, Winback
            captures it, re-reads the conversation with the same AI, and
            surfaces the reply plus the updated classification in your
            dashboard &mdash; so new context (they changed their mind,
            clarified a reason, pushed back) shapes whatever happens next.
          </p>
        ),
      },
      {
        q: 'Will my customers feel spammed?',
        a: (
          <p>
            One email per cancellation. Every email carries a visible
            unsubscribe link plus the <code>List-Unsubscribe</code> header so
            Gmail and Outlook show a one-click unsubscribe button. No drip
            sequences, no follow-ups we didn&rsquo;t tell you about.
          </p>
        ),
      },
      {
        q: 'What if someone unsubscribes or asks to be forgotten?',
        a: (
          <p>
            Unsubscribes are honoured immediately &mdash; we flag the
            subscriber and never email them again. For full deletion under
            GDPR Article 17, email{' '}
            <a href="mailto:privacy@winbackflow.co" className="text-blue-600 hover:underline">
              privacy@winbackflow.co
            </a>{' '}
            and we&rsquo;ll delete them from our database within 30 days.
            Details in our{' '}
            <Link href="/privacy" className="text-blue-600 hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        ),
      },
      {
        q: 'Can I review emails before they go out?',
        a: (
          <p>
            You review and approve the template and tone during onboarding.
            After that, emails send automatically within about a minute of the
            cancellation &mdash; the speed is what makes win-back work.
          </p>
        ),
      },
      {
        q: 'Can I pause Winback?',
        a: (
          <p>
            Yes. You can pause sending from Settings at any time. While
            paused, no win-back emails go out. Cancellations continue to be
            recorded on your dashboard so nothing is lost &mdash; useful for
            migrations, incidents, or holidays.
          </p>
        ),
      },
    ],
  },
  {
    heading: 'Pricing & recovery',
    items: [
      {
        q: 'What counts as a \u201Crecovery\u201D?',
        a: (
          <p>
            A recovery is when a cancelled subscriber who received a Winback
            email comes back and starts paying you again. We verify it against
            your Stripe subscription data.
          </p>
        ),
      },
      {
        q: 'What happens after the 12-month attribution window?',
        a: (
          <p>
            Nothing &mdash; they&rsquo;re yours permanently. From month 13
            onwards we stop billing on that subscriber and you keep 100% of
            their revenue.
          </p>
        ),
      },
      {
        q: 'What if a recovered subscriber cancels again?',
        a: (
          <p>
            We stop billing immediately. You only pay 15% for the months
            they&rsquo;re actively paying you.
          </p>
        ),
      },
      {
        q: 'Do I pay anything at signup?',
        a: (
          <p>
            No card at signup. We ask for a payment method after your first
            recovery and bill monthly from there. If we recover nothing, you
            pay nothing.
          </p>
        ),
      },
      {
        q: 'How is the fee calculated?',
        a: (
          <p>
            15% of each recovered subscriber&rsquo;s monthly revenue, for up
            to 12 months each. No base fee, no cap, no tiers.{' '}
            <Link href="/pricing" className="text-blue-600 hover:underline">
              Calculator &rarr;
            </Link>
          </p>
        ),
      },
    ],
  },
  {
    heading: 'Reliability & control',
    items: [
      {
        q: 'What if a webhook fails or Stripe is down?',
        a: (
          <p>
            Stripe retries events for up to three days. Our handlers are
            idempotent &mdash; replaying an event never creates duplicates.
            You won&rsquo;t miss a cancellation.
          </p>
        ),
      },
      {
        q: 'What happens if a Winback customer misuses the product?',
        a: (
          <p>
            We publish an{' '}
            <Link href="/aup" className="text-blue-600 hover:underline">
              Acceptable Use Policy
            </Link>
            . Breach is grounds for immediate suspension. We monitor spam
            complaints on our sending domain automatically and pause any
            account over a 0.3% complaint rate. Report abuse to{' '}
            <a href="mailto:abuse@winbackflow.co" className="text-blue-600 hover:underline">
              abuse@winbackflow.co
            </a>
            .
          </p>
        ),
      },
      {
        q: 'Is Winback GDPR-compliant?',
        a: (
          <p>
            Yes. We operate as a data processor under Article 28. Our{' '}
            <Link href="/dpa" className="text-blue-600 hover:underline">
              Data Processing Agreement
            </Link>
            ,{' '}
            <Link href="/privacy" className="text-blue-600 hover:underline">
              Privacy Policy
            </Link>
            , and{' '}
            <Link href="/terms" className="text-blue-600 hover:underline">
              Terms
            </Link>{' '}
            cover the details, including breach notification and subprocessor
            management.
          </p>
        ),
      },
      {
        q: 'Who runs Winback?',
        a: (
          <p>
            Winback is operated by{' '}
            <strong>[Company name &mdash; to be registered]</strong>, a company
            registered in England and Wales. Contact:{' '}
            <a href="mailto:support@winbackflow.co" className="text-blue-600 hover:underline">
              support@winbackflow.co
            </a>
            . <span className="text-slate-500 italic">(We&rsquo;ll update this entry once the company is formally incorporated.)</span>
          </p>
        ),
      },
    ],
  },
]

export default function FAQPage() {
  return (
    <main className="min-h-screen bg-[#f5f5f5] py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3">
          FAQ
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2">Questions, answered.</h1>
        <p className="text-sm text-slate-500 mb-10">
          Stripe access, customer experience, pricing, and GDPR. If you
          don&rsquo;t see your question,{' '}
          <Link href="/contact" className="text-blue-600 hover:underline">
            get in touch
          </Link>
          .
        </p>

        {SECTIONS.map((section) => (
          <section key={section.heading} className="mb-10">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400 pb-3 border-b border-slate-200">
              {section.heading}
            </h2>
            <div className="divide-y divide-slate-100">
              {section.items.map(({ q, a }) => (
                <details key={q} className="group py-4">
                  <summary className="cursor-pointer list-none flex items-start justify-between gap-4 text-sm font-medium text-slate-900 hover:text-blue-600">
                    <span>{q}</span>
                    <span className="text-slate-400 group-open:rotate-45 transition-transform flex-shrink-0">
                      +
                    </span>
                  </summary>
                  <div className="mt-3 text-sm text-slate-600 leading-relaxed">
                    {a}
                  </div>
                </details>
              ))}
            </div>
          </section>
        ))}

        <div className="mt-12 pt-6 border-t border-slate-200 text-xs text-slate-400 flex items-center justify-between">
          <div>
            Still have a question?{' '}
            <a href="mailto:support@winbackflow.co" className="text-blue-600 hover:underline">
              Email support
            </a>
            .
          </div>
          <Link href="/" className="hover:text-slate-900">&larr; Home</Link>
        </div>
      </div>
    </main>
  )
}

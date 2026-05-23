import Link from 'next/link'
import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'

export const metadata = {
  title: 'Questions — Winback',
  description:
    'How WinbackFlow works, Stripe access, when emails go out, tiered pricing, and GDPR — answered.',
}

interface QA {
  q: string
  a: React.ReactNode
}

interface Section {
  heading: string
  items: QA[]
}

const SECTIONS: Section[] = [
  {
    heading: 'Setup & your Stripe data',
    items: [
      {
        q: 'What access does WinbackFlow have to my Stripe?',
        a: (
          <p>
            We connect via Stripe&rsquo;s standard OAuth flow &mdash; Stripe
            shows you the exact permissions on the consent screen before you
            approve. We <em>read</em> your customers, subscriptions, and
            cancellation events so we can detect churn and compute MRR. We
            use <em>write</em> access for one purpose only: renewing a
            subscription when a customer accepts a winback offer &mdash; we
            never create new subscriptions out of nowhere, never refund,
            never change prices. You can disconnect us any time from
            Stripe Dashboard &rarr; Apps.
          </p>
        ),
      },
      {
        q: 'Can WinbackFlow charge my customers or change my prices?',
        a: (
          <p>
            No. We never create charges, never issue refunds, never change
            prices or plan configurations. The only write action we take
            is renewing a cancelled subscription when a customer clicks
            your winback offer &mdash; and that only restores what they
            previously had.
          </p>
        ),
      },
      {
        q: 'What happens if I disconnect Stripe?',
        a: (
          <p>
            We stop receiving cancellation events immediately and stop
            sending emails. Nothing on your Stripe side changes &mdash;
            your subscriptions, customers, and prices are untouched.
          </p>
        ),
      },
      {
        q: 'Where is my data stored?',
        a: (
          <p>
            On servers in the US (AWS us-east-2), under EU Standard
            Contractual Clauses. The full list of subprocessors is at{' '}
            <Link href="/subprocessors" className="text-blue-600 hover:underline">
              /subprocessors
            </Link>
            .
          </p>
        ),
      },
    ],
  },
  {
    heading: 'How the emails work',
    items: [
      {
        q: 'When does WinbackFlow email my cancelled subscribers?',
        a: (
          <>
            <p>
              Only when you ship an improvement that matches a stored
              cancellation reason. WinbackFlow does NOT send an email at
              the moment of cancellation &mdash; the AI is listen-only at
              that stage. It records the reason and groups it into a
              theme, and that&rsquo;s it.
            </p>
            <p className="mt-3">
              When you later publish a shipped improvement in your
              dashboard (e.g. &ldquo;Shipped Slack integration with
              channel routing&rdquo;), WinbackFlow scans every cancellation
              reason from the last 12 months and finds the subscribers who
              cited that theme. Each one gets exactly one email naming what
              they asked for and what you delivered.
            </p>
            <p className="mt-3">
              No drip sequences. No exit emails. No AI replies. The only
              email a subscriber gets from us is the one tied to a shipped
              fix they specifically asked for.
            </p>
          </>
        ),
      },
      {
        q: 'Will my customers feel spammed?',
        a: (
          <p>
            At most one email per subscriber per shipped match &mdash; never
            a drip, never a follow-up sequence. Payment-recovery emails
            (up to three, timed to lead Stripe&rsquo;s automatic retries)
            stop the moment Stripe collects. Every email carries a visible
            unsubscribe link plus the <code>List-Unsubscribe</code> header
            for one-click unsubscribe in Gmail and Outlook.
          </p>
        ),
      },
      {
        q: 'Who does the email come from?',
        a: (
          <p>
            Your name on the From line, from our verified sending domain.
            Replies go to your normal inbox &mdash; WinbackFlow
            doesn&rsquo;t intercept the conversation or auto-respond. From
            there it&rsquo;s a direct conversation between you and the
            subscriber.
          </p>
        ),
      },
      {
        q: 'Can I attach a discount code to winback emails?',
        a: (
          <>
            <p>
              Yes. From Settings &rarr; Reasons you can select a single
              Stripe promotion code at a time to offer with winback emails
              (or skip &mdash; many merchants find a personal-sounding
              email outperforms a discount). Switching the active code is
              one click.
            </p>
            <p className="mt-3">
              Before showing the code to a subscriber, WinbackFlow
              verifies four gates against Stripe in real time:
            </p>
            <ul className="mt-3 space-y-1.5 list-disc pl-5">
              <li>The promotion code is <strong>active</strong> in Stripe.</li>
              <li>It hasn&rsquo;t passed its <strong>redemption deadline</strong>.</li>
              <li>It hasn&rsquo;t hit its <strong>max-redemptions cap</strong>.</li>
              <li>It <strong>applies to the price</strong> the subscriber was on.</li>
            </ul>
            <p className="mt-3">
              If any gate fails, the email goes out without the offer
              rather than leading the customer to a broken checkout.
            </p>
            <p className="mt-3">
              <strong>One thing you have to set up on the Stripe side:</strong>{' '}
              make sure your cancelled customers are <em>eligible</em> to
              redeem the code. We verify the four gates above, but we
              can&rsquo;t override Stripe&rsquo;s customer-eligibility
              rules at checkout:
            </p>
            <ul className="mt-3 space-y-1.5 list-disc pl-5">
              <li>
                Don&rsquo;t tick <strong>&ldquo;First-time transaction
                only&rdquo;</strong> on the coupon &mdash; your cancelled
                customers have already paid you before.
              </li>
              <li>
                If you&rsquo;ve restricted the code to a specific{' '}
                <strong>customer list</strong>, make sure the cancelled
                cohort is in it.
              </li>
              <li>
                Currency, region, and product/price restrictions still
                apply at Stripe checkout.
              </li>
            </ul>
            <p className="mt-3">
              Skip these and the customer clicks through to a Stripe
              checkout that says &ldquo;This code is not valid&rdquo;
              &mdash; not WinbackFlow&rsquo;s rejection, Stripe&rsquo;s.
              Worth a 30-second sanity check when you create the code.
            </p>
          </>
        ),
      },
      {
        q: 'What if someone unsubscribes or asks to be forgotten?',
        a: (
          <p>
            Unsubscribes are honoured immediately &mdash; we flag the
            subscriber and never email them again. For full deletion
            under GDPR Article 17, email{' '}
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
    ],
  },
  {
    heading: 'Pricing',
    items: [
      {
        q: 'How does pricing work?',
        a: (
          <>
            <p>
              One flat monthly fee priced by your own MRR. No
              per-recovery charges, no performance fees, no usage caps.
            </p>
            <ul className="mt-3 space-y-2 list-disc pl-5">
              <li><strong>Starter</strong> &mdash; MRR up to $50k &mdash; $99 / month</li>
              <li><strong>Growth</strong> &mdash; MRR $50k &ndash; $250k &mdash; $299 / month</li>
              <li><strong>Scale</strong> &mdash; MRR $250k &ndash; $1M &mdash; $699 / month</li>
              <li><strong>Enterprise</strong> &mdash; MRR $1M+ &mdash; custom, sales-handled</li>
            </ul>
            <p className="mt-3">
              <Link href="/pricing" className="text-blue-600 hover:underline">
                See full pricing &rarr;
              </Link>
            </p>
          </>
        ),
      },
      {
        q: 'Do I pay anything at signup?',
        a: (
          <p>
            No card at signup. WinbackFlow runs free until we deliver your
            first payment recovery or cancellation winback. Only then do
            we prompt you in-app to confirm your tier and subscribe. If
            we deliver nothing, you pay nothing.
          </p>
        ),
      },
      {
        q: 'Can my tier change later?',
        a: (
          <p>
            Yes, but never automatically. We re-compute your MRR weekly.
            If it grows into a higher tier and stays there for 14 days,
            you&rsquo;ll see an upgrade prompt in your dashboard and
            settings. Same for downgrades. In both directions, you
            decide &mdash; the Stripe Customer Portal handles the switch.
          </p>
        ),
      },
      {
        q: 'Can I cancel? What happens to my data?',
        a: (
          <p>
            One-click cancel via your billing settings &mdash; no
            retention friction. The subscription ends at the close of
            your current cycle. Your data stays intact, and WinbackFlow
            keeps running for free. The next delivered recovery will
            prompt you to re-subscribe at the tier matching your
            then-current MRR.
          </p>
        ),
      },
    ],
  },
  {
    heading: 'Both flows',
    items: [
      {
        q: 'Does WinbackFlow handle failed payments too?',
        a: (
          <>
            <p>
              Yes &mdash; roughly half the lost revenue most subscription
              businesses leave on the table. When a card fails we send a{' '}
              <strong>three-touch email sequence</strong> timed to lead
              Stripe&rsquo;s automatic retries (immediate, ~24h before
              retry #2, ~24h before the final retry), each with a
              one-click update-payment link. Auto-stops the moment Stripe
              collects.
            </p>
            <p className="mt-3">
              These are rule-based decline-aware emails &mdash; not
              AI-written. Everything shows up in the same dashboard as
              cancellation winbacks, tagged so you can tell them apart.
            </p>
          </>
        ),
      },
      {
        q: 'Is WinbackFlow GDPR-compliant?',
        a: (
          <p>
            Yes &mdash; we operate as a data processor under Article 28.
            See our{' '}
            <Link href="/dpa" className="text-blue-600 hover:underline">
              DPA
            </Link>
            ,{' '}
            <Link href="/privacy" className="text-blue-600 hover:underline">
              Privacy Policy
            </Link>
            , and{' '}
            <Link href="/terms" className="text-blue-600 hover:underline">
              Terms
            </Link>{' '}
            for breach notification, subprocessor management, and
            data-subject rights.
          </p>
        ),
      },
    ],
  },
]

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
    <StickyNav />
    <main className="py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3">
          Questions
        </div>
        <h1 className="text-4xl font-bold text-slate-900 mb-2">Questions, answered.</h1>
        <p className="text-sm text-slate-500 mb-10">
          Stripe access, your subscribers&rsquo; experience, pricing, and
          GDPR. If you don&rsquo;t see your question,{' '}
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
    <Footer />
    </div>
  )
}

import Link from 'next/link'
import { Footer } from '@/components/landing/footer'

export const metadata = {
  title: 'FAQ — Winback',
  description:
    'Stripe access, payment recovery + win-back emails, pricing, and GDPR — answered.',
}

interface QA {
  q: string
  a: React.ReactNode
}

type Section =
  | { heading: string; items: QA[] }
  | { heading: string; subsections: Array<{ heading: string; items: QA[] }> }

const SECTIONS: Section[] = [
  {
    heading: 'Dashboard',
    subsections: [
      {
        heading: 'Win-backs',
        items: [
          {
            q: 'How is "Recovery rate (30d)" calculated on the Win-backs tab?',
            a: (
              <p>
                The share of recent voluntary cancellations that have been
                won back. Numerator: customers who cancelled in the last 30
                days and were later recovered. Denominator: all customers
                who cancelled in the last 30 days. The window rolls — a
                brand-new tenant starts seeing meaningful numbers within
                1&ndash;2 weeks. Failed-payment cancellations are excluded
                here; they live in the Payment recoveries tab.
              </p>
            ),
          },
          {
            q: 'How is "Recovered · lifetime" calculated on the Win-backs tab?',
            a: (
              <p>
                A count of every customer Winback has brought back from a
                voluntary cancellation since you connected. Lifetime &mdash;
                only grows. The &ldquo;+N vs last month&rdquo; delta
                underneath compares this calendar month to the previous one.
              </p>
            ),
          },
          {
            q: 'How is "Revenue saved · lifetime" calculated on the Win-backs tab?',
            a: (
              <>
                <p>
                  For each recovered customer we count whole 30-day months
                  they&rsquo;ve stayed subscribed since their recovery,
                  multiply by their MRR at the time of recovery, and sum
                  across all recoveries. A $20/mo customer recovered six
                  months ago = $120 saved. If they later re-churned,
                  retention ends at the re-churn date.
                </p>
                <p className="mt-3">
                  We round down to whole months to be conservative &mdash; a
                  customer recovered 25 days ago contributes $0 until
                  they&rsquo;ve actually been billed for a month. The number
                  is refreshed by a background job daily (so it&rsquo;s at
                  most 24 hours stale; the dashboard read is instant).
                </p>
                <p className="mt-3">
                  The &ldquo;$X/mo currently active&rdquo; sub-line is the
                  run-rate: the sum of MRR for recovered win-back
                  subscribers still subscribed today.
                </p>
              </>
            ),
          },
          {
            q: 'How is "In progress" calculated on the Win-backs tab?',
            a: (
              <p>
                The count of cancelled customers Winback is actively working
                on &mdash; emails sent, awaiting reply or follow-up.
                Excludes anyone already recovered, lost, or paused.
              </p>
            ),
          },
          {
            q: 'What is the "Top reasons" strip above the Win-backs table?',
            a: (
              <p>
                The four most common cancellation categories from the last
                30 days, with percentages. Hidden when fewer than three
                cancellations land in the window &mdash; a one- or two-row
                sample produces a misleading &ldquo;100%&rdquo; reading, so
                we wait for real signal before showing it.
              </p>
            ),
          },
        ],
      },
      {
        heading: 'Payment recoveries',
        items: [
          {
            q: 'How is "Recovery rate (30d)" calculated on the Payment recoveries tab?',
            a: (
              <p>
                The share of recent failed payments that have been resolved.
                Numerator: failed payments from the last 30 days where the
                customer updated their card and the charge succeeded.
                Denominator: all failed payments in the last 30 days.
                Anchored on the date the failure first arrived (not a
                cancellation date &mdash; payment-recovery rows
                don&rsquo;t have one).
              </p>
            ),
          },
          {
            q: 'How is "Recovered · lifetime" calculated on the Payment recoveries tab?',
            a: (
              <p>
                A count of every failed payment Winback has ever recovered.
                Lifetime, with a month-over-month delta underneath.
              </p>
            ),
          },
          {
            q: 'How is "Revenue saved · lifetime" calculated on the Payment recoveries tab?',
            a: (
              <p>
                The same calculation and same number as on the Win-backs tab
                &mdash; we surface saved revenue as a single ROI figure
                across both recovery types rather than splitting it. The
                &ldquo;$X/mo currently active&rdquo; sub-line on this tab
                is the run-rate of recovered failed-payment subscribers
                still subscribed today.
              </p>
            ),
          },
          {
            q: 'How is "In dunning" calculated?',
            a: (
              <p>
                The count of failed-payment subscribers currently in the
                retry sequence &mdash; either awaiting Stripe&rsquo;s next
                automatic retry, or on the final retry attempt. Excludes
                anyone already recovered or churned during dunning.
              </p>
            ),
          },
          {
            q: 'What is the "Top decline codes" strip above the Payment recoveries table?',
            a: (
              <p>
                The four most common bank-decline reasons from the last 30
                days (<code>insufficient_funds</code>, <code>expired_card</code>,
                <code>do_not_honor</code>, etc.) &mdash; same shape and same
                3-row floor as the Win-backs &ldquo;Top reasons&rdquo; strip.
              </p>
            ),
          },
        ],
      },
    ],
  },
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
      {
        q: 'Does Winback handle failed payments too?',
        a: (
          <>
            <p>
              Yes. When a subscriber&rsquo;s card fails, Winback emails them
              a one-click link to update their payment method &mdash; before
              Stripe&rsquo;s retries run out and the subscription is cancelled
              for real. This is involuntary churn, and it&rsquo;s roughly half
              the lost revenue most subscription businesses leave on the table.
            </p>
            <p className="mt-3">
              These emails aren&rsquo;t AI-written because they don&rsquo;t
              need to be: the customer wanted to stay, the card just broke.
              One short, utilitarian message with a tracked update-payment
              link. Everything shows up in the same dashboard as voluntary
              cancellations, tagged so you can tell them apart.
            </p>
          </>
        ),
      },
    ],
  },
  {
    heading: 'Pricing & recovery',
    items: [
      {
        q: 'How does pricing work?',
        a: (
          <>
            <p>
              Two fees. A flat <strong>$99/mo platform fee</strong> that
              includes up to <strong>500 payment recoveries per month</strong>
              {' '}&mdash; the emails we send when a subscriber&rsquo;s payment
              fails so they can update their card. And a one-time{' '}
              <strong>performance fee equal to one month of the
              subscriber&rsquo;s MRR</strong> when we win back a cancelled
              subscriber. Charged once per win-back, never recurring.
            </p>
            <p className="mt-3">
              <Link href="/pricing" className="text-blue-600 hover:underline">
                See full pricing &rarr;
              </Link>
            </p>
          </>
        ),
      },
      {
        q: 'What counts as a win-back?',
        a: (
          <>
            <p>
              A subscriber comes back after we engaged with them.
              Specifically, one of:
            </p>
            <ul className="mt-3 space-y-2 list-disc pl-5">
              <li>They clicked our reactivate link.</li>
              <li>They replied to our email.</li>
              <li>
                They came back within 30 days of us escalating to you (a
                &ldquo;handoff&rdquo;).
              </li>
              <li>
                They came back within 30 days of you pausing our AI for
                them.
              </li>
            </ul>
            <p className="mt-3">
              Payment recoveries are billed separately &mdash; covered by
              the $99/mo platform fee.
            </p>
          </>
        ),
      },
      {
        q: 'If I personally write back to a customer Winback handed off to me, who earns the fee?',
        a: (
          <>
            <p>
              The fee covers detection and surfacing, not the reply. Our
              AI catches the cancellation, classifies why, and gets the
              case in front of you fast &mdash; without that, the customer
              would&rsquo;ve been just another quiet churn in your Stripe
              dashboard. The conversation you have with them is yours;
              we&rsquo;re charging for the pipeline that made that
              conversation possible.
            </p>
            <p className="mt-3">
              Same logic when you pause our AI to handle a subscriber
              yourself.
            </p>
          </>
        ),
      },
      {
        q: 'What if someone reactivates without us doing anything?',
        a: (
          <>
            <p>No bill if we did nothing. That covers:</p>
            <ul className="mt-3 space-y-2 list-disc pl-5">
              <li>
                <strong>Organic</strong> &mdash; they came back on their
                own. No email engagement, no handoff, no pause.
              </li>
              <li>
                <strong>Weak</strong> &mdash; we sent an email but they
                didn&rsquo;t click, didn&rsquo;t reply, and we didn&rsquo;t
                escalate.
              </li>
            </ul>
            <p className="mt-3">
              Both still count as recoveries in your dashboard &mdash;
              that&rsquo;s the full picture of what came back. The fee
              fires only when we can point to a verifiable trigger
              (click, reply, handoff, or pause).
            </p>
          </>
        ),
      },
      {
        q: 'What if a won-back subscriber cancels again?',
        a: (
          <p>
            If they re-cancel within 14 days of the win-back, we refund the
            entire performance fee. After 14 days, the fee stands &mdash;
            they had a real period of paid revenue.
          </p>
        ),
      },
      {
        q: 'What about Stripe\u2019s own retries?',
        a: (
          <p>
            Stripe&rsquo;s Smart Retries already recover a chunk of failed
            payments on their own. Our payment-recovery emails handle the
            rest &mdash; the failures Stripe gives up on. Either way, you pay
            the same $99/mo. No incremental fee per recovery, up to 500/mo.
          </p>
        ),
      },
      {
        q: 'Do I pay anything at signup?',
        a: (
          <p>
            No card at signup. We ask for a payment method after we deliver
            your first payment recovery or win-back, whichever comes first.
            The $99 platform fee starts on that same invoice. If we deliver
            nothing, you pay nothing.
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
            <strong>Axiomis OÜ trading as Winback</strong>, a company
            registered in Estonia (Reg. no. 17493372, Sepapaja tn 6, 15551 Tallinn). Contact:{' '}
            <a href="mailto:support@winbackflow.co" className="text-blue-600 hover:underline">
              support@winbackflow.co
            </a>
            .
          </p>
        ),
      },
    ],
  },
]

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-[#f5f5f5]">
    <main className="py-12 px-6">
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
            {'subsections' in section ? (
              section.subsections.map((sub) => (
                <details key={sub.heading} className="group/sub mt-4">
                  <summary className="cursor-pointer list-none flex items-center justify-between gap-4 text-sm font-semibold text-slate-900 hover:text-blue-600 py-3 border-b border-slate-100">
                    <span>{sub.heading}</span>
                    <span className="text-slate-400 group-open/sub:rotate-45 transition-transform flex-shrink-0">
                      +
                    </span>
                  </summary>
                  <div className="divide-y divide-slate-100 mt-1 pl-1">
                    {sub.items.map(({ q, a }) => (
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
                </details>
              ))
            ) : (
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
            )}
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

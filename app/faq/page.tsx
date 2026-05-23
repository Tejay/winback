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

type Section =
  | { heading: string; items: QA[] }
  | { heading: string; subsections: Array<{ heading: string; items: QA[] }> }

const SECTIONS: Section[] = [
  {
    heading: 'Dashboard',
    subsections: [
      {
        heading: 'Cancellation winbacks',
        items: [
          {
            q: 'How is "Recovery rate (30d)" calculated on the Cancellation winbacks tab?',
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
            q: 'How is "Recovered · lifetime" calculated on the Cancellation winbacks tab?',
            a: (
              <p>
                A count of every customer we&rsquo;ve brought back from a
                voluntary cancellation since you connected. Lifetime &mdash;
                only grows. The &ldquo;+N vs last month&rdquo; delta
                underneath compares this calendar month to the previous one.
              </p>
            ),
          },
          {
            q: 'How is "Revenue saved · lifetime" calculated on the Cancellation winbacks tab?',
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
                  run-rate: the sum of MRR for recovered cancellation
                  winback subscribers still subscribed today.
                </p>
              </>
            ),
          },
          {
            q: 'How is "In progress" calculated on the Cancellation winbacks tab?',
            a: (
              <p>
                The count of cancelled customers we&rsquo;re actively
                working on &mdash; emails sent, awaiting reply or
                follow-up. Excludes anyone already recovered, lost, or
                paused.
              </p>
            ),
          },
          {
            q: 'What is the "Top reasons" strip above the Cancellation winbacks table?',
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
                A count of every failed payment we&rsquo;ve ever recovered.
                Lifetime, with a month-over-month delta underneath.
              </p>
            ),
          },
          {
            q: 'How is "Revenue saved · lifetime" calculated on the Payment recoveries tab?',
            a: (
              <p>
                The same calculation and same number as on the Cancellation winbacks tab
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
                3-row floor as the Cancellation winbacks &ldquo;Top reasons&rdquo; strip.
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
              behalf when a customer accepts a cancellation winback offer, so they can
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
            clicks your cancellation winback offer &mdash; and that only restores what
            they previously had.
          </p>
        ),
      },
      {
        q: 'What happens if I disconnect Stripe?',
        a: (
          <p>
            We stop receiving cancellation events immediately and stop sending
            cancellation winback emails. Nothing on your Stripe side changes &mdash; your
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
              cited that theme. Each one gets exactly one email naming
              what they asked for and what you delivered.
            </p>
            <p className="mt-3">
              No drip sequences. No exit emails. No AI replies. The only
              email a subscriber gets from us is the one tied to a
              shipped fix they specifically asked for.
            </p>
          </>
        ),
      },
      {
        q: 'Who does the email come from?',
        a: (
          <p>
            Sent with your name on the From line (e.g., <em>Alex Smith</em>)
            from our verified sending domain. If a subscriber replies,
            the reply goes to your normal inbox &mdash; WinbackFlow
            doesn&rsquo;t intercept the conversation or auto-respond.
            From there it&rsquo;s a direct conversation between you and
            them.
          </p>
        ),
      },
      {
        q: 'Will my customers feel spammed?',
        a: (
          <>
            <p>
              No drip sequences. Cadence per flow:
            </p>
            <ul className="mt-3 space-y-2 list-disc pl-5">
              <li>
                <strong>Cancellation winback</strong>: at most one email
                per subscriber, sent only when you ship something
                matching what they asked for. A subscriber who cited
                multiple cancellation themes could in theory receive
                multiple targeted emails over time, one per matching
                ship &mdash; but never two for the same improvement.
              </li>
              <li>
                <strong>Payment recovery</strong>: up to three emails per
                failed payment, timed to lead Stripe&rsquo;s automatic
                retries (immediate, ~24h before retry #2, ~24h before the
                final retry). Stops the moment Stripe collects or the
                subscription is fully cancelled.
              </li>
            </ul>
            <p className="mt-3">
              Every email carries a visible unsubscribe link plus the{' '}
              <code>List-Unsubscribe</code> header so Gmail and Outlook
              show a one-click unsubscribe button.
            </p>
          </>
        ),
      },
      {
        q: 'How does WinbackFlow know what a subscriber asked for?',
        a: (
          <>
            <p>
              From the exit reason they typed in Stripe&rsquo;s cancel
              box. WinbackFlow reads that text with an LLM, classifies it
              into a theme, and stores both the raw text and the theme.
            </p>
            <p className="mt-3">
              The dashboard shows you the themes ranked by lost MRR
              &mdash; so when you&rsquo;re deciding what to build next,
              the prioritisation is grounded in churn dollars, not gut
              feel.
            </p>
          </>
        ),
      },
      {
        q: 'What if a subscriber doesn’t give a reason?',
        a: (
          <p>
            If no reason is captured in Stripe, that subscriber sits in
            an unclassified bucket. They won&rsquo;t match any
            improvement and won&rsquo;t receive a re-engagement email
            &mdash; we can&rsquo;t tell them &ldquo;we shipped what you
            asked for&rdquo; if we don&rsquo;t know what they asked for.
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
          <>
            <p>
              You review and approve the template and tone during
              onboarding. After that:
            </p>
            <ul className="mt-3 space-y-2 list-disc pl-5">
              <li>
                <strong>Cancellation-winback emails are AI-drafted</strong>
                {' '}from the improvement description you publish + the
                stored theme. The AI fills in the personalisation
                &mdash; what the customer originally said, what you
                shipped, why it addresses their reason &mdash; in your
                approved voice. You can preview any pending send in
                Settings.
              </li>
              <li>
                <strong>Payment-recovery emails are rule-based</strong>,
                not AI-written. A short utilitarian sequence keyed to
                the Stripe decline code (expired card vs insufficient
                funds vs hard decline). The customer wanted to stay; the
                card just broke. No AI needed.
              </li>
            </ul>
            <p className="mt-3">
              You can pause sending in Settings any time if you want to
              handle a specific subscriber yourself.
            </p>
          </>
        ),
      },
      {
        q: 'Can I attach a discount code to cancellation winback emails?',
        a: (
          <>
            <p>
              Yes. From Settings &rarr; Reasons you can select a single
              Stripe promotion code at a time to offer with
              cancellation winback emails (or skip &mdash; many merchants find a
              personal-sounding email outperforms a discount). Switching
              the active code is one click.
            </p>
            <p className="mt-3">
              Before showing the code to a subscriber, Winback verifies
              four gates against Stripe in real time:
            </p>
            <ul className="mt-3 space-y-1.5 list-disc pl-5">
              <li>The promotion code is <strong>active</strong> in Stripe.</li>
              <li>It hasn&rsquo;t passed its <strong>redemption deadline</strong>.</li>
              <li>It hasn&rsquo;t hit its <strong>max-redemptions cap</strong>.</li>
              <li>It <strong>applies to the price</strong> the subscriber was on.</li>
            </ul>
            <p className="mt-3">
              If any gate fails, the email goes out without the offer
              rather than leading the customer to a broken checkout. You
              choose the code; Winback handles the verification.
            </p>
            <p className="mt-3">
              <strong>One thing you have to set up on the Stripe side:</strong>{' '}
              make sure your cancelled customers are <em>eligible</em> to
              redeem the code. We can verify the four gates above, but we
              can&rsquo;t override Stripe&rsquo;s customer-eligibility
              rules at checkout. Specifically:
            </p>
            <ul className="mt-3 space-y-1.5 list-disc pl-5">
              <li>
                Don&rsquo;t tick <strong>&ldquo;First-time transaction
                only&rdquo;</strong> on the coupon &mdash; your cancelled
                customers have already paid you before, so Stripe would
                reject them at checkout.
              </li>
              <li>
                If you&rsquo;ve restricted the code to a specific{' '}
                <strong>customer list</strong>, make sure the cancelled
                cohort you&rsquo;re targeting is in it.
              </li>
              <li>
                Any other Stripe-side eligibility rules (currency, region,
                product/price restrictions) apply at checkout too &mdash;
                we can&rsquo;t see or override them.
              </li>
            </ul>
            <p className="mt-3">
              If you skip these, the customer clicks through to a Stripe
              checkout that says &ldquo;This code is not valid&rdquo;
              &mdash; not Winback&rsquo;s rejection, Stripe&rsquo;s. Worth
              a 30-second sanity check when you create the code.
            </p>
          </>
        ),
      },
      {
        q: 'Can I pause Winback?',
        a: (
          <p>
            Yes. You can pause sending from Settings at any time. While
            paused, no cancellation winback emails go out. Cancellations continue to be
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
              Yes &mdash; this is the payment-recovery flow, and it&rsquo;s
              roughly half the lost revenue most subscription businesses
              leave on the table. When a subscriber&rsquo;s card fails, we
              send a <strong>three-touch email sequence</strong> timed to
              lead Stripe&rsquo;s automatic retries:
            </p>
            <ul className="mt-3 space-y-2 list-disc pl-5">
              <li>
                <strong>Touch 1</strong> &mdash; immediate, soft heads-up
                with a link to update the card.
              </li>
              <li>
                <strong>Touch 2</strong> &mdash; about 24 hours before
                Stripe&rsquo;s retry #2, copy keyed to the specific
                decline code (expired vs insufficient vs hard decline).
              </li>
              <li>
                <strong>Touch 3</strong> &mdash; about 24 hours before
                Stripe&rsquo;s final retry, last-chance copy.
              </li>
            </ul>
            <p className="mt-3">
              Each email links to a one-click update flow so the customer
              can fix their card without re-typing details. The sequence
              auto-stops the moment Stripe collects (no double-charging)
              or the subscription is fully cancelled.
            </p>
            <p className="mt-3">
              These emails are rule-based decline-aware copy &mdash; not
              AI-written. Everything shows up in the same dashboard as
              voluntary cancellations, tagged so you can tell them apart.
            </p>
          </>
        ),
      },
    ],
  },
  {
    heading: 'Pricing & billing',
    items: [
      {
        q: 'How does pricing work?',
        a: (
          <>
            <p>
              One flat monthly fee priced by your own MRR. No per-recovery
              charges, no performance fees, no usage caps.
            </p>
            <ul className="mt-3 space-y-2 list-disc pl-5">
              <li>
                <strong>Starter</strong> &mdash; MRR up to $50k &mdash; $99 / month
              </li>
              <li>
                <strong>Growth</strong> &mdash; MRR $50k &ndash; $250k &mdash; $299 / month
              </li>
              <li>
                <strong>Scale</strong> &mdash; MRR $250k &ndash; $1M &mdash; $699 / month
              </li>
              <li>
                <strong>Enterprise</strong> &mdash; MRR $1M+ &mdash; custom,
                sales-handled
              </li>
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
        q: 'How is my tier decided?',
        a: (
          <>
            <p>
              From your own Stripe account. WinbackFlow reads your active
              subscriptions live (via Stripe Connect &mdash; no
              self-reporting) and computes your MRR using the same math
              Stripe shows on your dashboard.
            </p>
            <p className="mt-3">
              When it&rsquo;s time to subscribe, the activation page shows
              you the full breakdown &mdash; your computed MRR, the
              resulting tier, the monthly fee &mdash; before any charge.
              You click Subscribe at the displayed price. We never
              auto-charge a tier you didn&rsquo;t confirm.
            </p>
            <p className="mt-3">
              We err in your favor on band edges: if your MRR is within 5%
              of a tier boundary, you stay in the lower tier.
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
            we prompt you in-app to confirm your tier and subscribe. If we
            deliver nothing, you pay nothing.
          </p>
        ),
      },
      {
        q: 'Can my tier change later?',
        a: (
          <>
            <p>
              Yes, but never automatically. We re-compute your MRR every
              week. If it grows into a higher tier and stays there for 14
              days, you&rsquo;ll see an upgrade prompt in your dashboard
              and settings. Same for downgrades &mdash; if your MRR drops
              for 30 days (and stays at least 10% below the boundary, to
              avoid flapping), you&rsquo;ll see a downgrade option.
            </p>
            <p className="mt-3">
              In both directions, you decide. The Stripe Customer Portal
              handles the actual switch.
            </p>
          </>
        ),
      },
      {
        q: 'Are recoveries capped on any tier?',
        a: (
          <p>
            No. Every tier covers unlimited recovery volume &mdash; both
            payment recoveries and cancellation winbacks, however many of
            each. There are no overage fees and no usage charges.
          </p>
        ),
      },
      {
        q: 'What counts as a cancellation winback in my dashboard?',
        a: (
          <>
            <p>
              A previously-cancelled subscriber starts paying you again
              after we emailed them about a shipped improvement that
              matched their cancellation reason. The ROI display in your
              dashboard counts:
            </p>
            <ul className="mt-3 space-y-2 list-disc pl-5">
              <li>
                <strong>Strong</strong> &mdash; they clicked the
                reactivate link in our targeted improvement email and
                resubscribed.
              </li>
              <li>
                <strong>Weak</strong> &mdash; we sent the targeted
                improvement email; they didn&rsquo;t click it but
                resubscribed within the attribution window anyway.
              </li>
              <li>
                <strong>Organic</strong> &mdash; they came back on their
                own with no matching email having gone out. Recorded for
                your records; excluded from the &ldquo;Recovered&rdquo;
                figure to keep the ROI number defensible.
              </li>
            </ul>
            <p className="mt-3">
              None of this affects your bill. Your monthly fee is flat,
              based on your MRR tier &mdash; recoveries change the ROI
              number on your dashboard, not what you pay.
            </p>
          </>
        ),
      },
      {
        q: 'What if a won-back subscriber cancels again?',
        a: (
          <p>
            Your monthly fee doesn&rsquo;t change &mdash; it&rsquo;s flat
            per tier, independent of any individual recovery outcome. The
            re-cancellation does drop them out of your &ldquo;currently
            active&rdquo; revenue run-rate on the dashboard, and Winback
            re-classifies them as a new churn event with a fresh
            cancellation winback flow.
          </p>
        ),
      },
      {
        q: 'Can I cancel? What happens to my data?',
        a: (
          <p>
            One-click cancel via your billing settings &mdash; no
            retention friction. The subscription ends at the close of your
            current cycle. Your data stays intact, and WinbackFlow keeps
            running recovery and winback on your account for free. The
            next delivered recovery will prompt you in-app to re-subscribe
            at the tier matching your then-current MRR.
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
            . Breach is grounds for immediate suspension. We monitor
            complaint rate on our sending domain continuously and pause
            any account where deliverability becomes a problem. Report
            abuse to{' '}
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
    <StickyNav />
    <main className="py-12 px-6">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
        <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-3">
          Questions
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

import Link from 'next/link'
import { PoweredByStripe } from '@/components/powered-by-stripe'
import { StickyNav } from '@/components/landing/sticky-nav'
import { FlowIllustration } from '@/components/landing/flow-illustration'
import Image from 'next/image'
import { StepCard } from '@/components/landing/step-card'
import { RevealOnScroll } from '@/components/landing/reveal-on-scroll'
import { Zap, Brain, Send, CreditCard } from 'lucide-react'

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />

      {/* Section 2 — Hero */}
      <section className="bg-[#eef2fb] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6 flex flex-col items-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600 text-center">
            For subscription businesses losing customers every month
          </div>

          <h1 className="mt-6 text-center tracking-tight leading-[1.05] max-w-4xl">
            <span className="block text-4xl sm:text-6xl font-bold text-slate-900">
              Win<span className="text-green-500">back</span> lost customers.
            </span>
            <span className="block text-4xl sm:text-6xl font-bold text-slate-400">
              Automatically.
            </span>
          </h1>

          <p className="mt-6 text-base sm:text-lg text-slate-600 max-w-2xl text-center leading-relaxed">
            AI-written, personalised win-back emails tuned to each cancelled
            subscriber&rsquo;s reason, plan, and history.{' '}
            <span className="text-slate-900 font-medium">
              Not a template. Not a broadcast.
            </span>
          </p>

          <p className="mt-3 text-sm sm:text-base text-slate-500 max-w-2xl text-center leading-relaxed">
            Plus automatic card-recovery emails when payments fail — two kinds
            of lost revenue, one Stripe connection.
          </p>

          <div className="flex flex-col items-center gap-2 mt-8">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-7 py-3 text-base font-medium hover:bg-[#1e293b]"
            >
              Start free — no card →
            </Link>
            <p className="text-sm text-slate-500">
              Connect Stripe · No card at signup.
            </p>
          </div>

          <FlowIllustration />
        </div>
      </section>

      {/* Section 3 — How it works */}
      <section id="how-it-works" className="bg-[#f5f5f5] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              How it works
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
              Three steps.
            </h2>
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900">
              Zero manual work.
            </h2>
            <p className="text-base sm:text-lg text-slate-500 mt-4 max-w-2xl mx-auto">
              No fixed workflows, no generic templates. Every email is written
              from scratch for the subscriber in front of it.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-16">
            <RevealOnScroll delay={0}>
            <StepCard
              step="01"
              label="Detect"
              title="Catch every cancellation."
              icon={Zap}
              tint="amber"
              body="The moment a subscriber cancels on Stripe, Winback picks it up — with the customer, plan, and exit reason attached."
              details={
                <>
                  <p>
                    Every cancellation lands in Winback the second it happens
                    &mdash; who cancelled, what they were paying, how long
                    they&rsquo;d been a customer, and any reason they gave
                    (including whatever they typed in Stripe&rsquo;s cancel
                    box).
                  </p>
                </>
              }
            />
            </RevealOnScroll>
            <RevealOnScroll delay={120}>
            <StepCard
              step="02"
              label="Decide"
              title="Read the full situation."
              icon={Brain}
              tint="blue"
              body="AI weighs the exit reason, account history, tenure, and product fit — then picks the angle most likely to bring them back."
              details={
                <>
                  <p>
                    Winback reads the cancellation reason against what you&rsquo;ve
                    shipped since they subscribed, their tenure, their plan,
                    and the signal strength of the feedback. From there it
                    picks the response that actually fits:
                  </p>
                  <ul className="list-disc pl-5 space-y-1">
                    <li>Accountability when it&rsquo;s a quality issue</li>
                    <li>Education when they missed a feature</li>
                    <li>A genuine update when something has changed</li>
                    <li>Silence when contact would do more harm than good</li>
                  </ul>
                </>
              }
            />
            </RevealOnScroll>
            <RevealOnScroll delay={240}>
            <StepCard
              step="03"
              label="Act"
              title="Send the email that fits."
              icon={Send}
              tint="emerald"
              body="A personalised message tailored to their exact situation. Replies route to your inbox. Not a generic drip. Not a blast."
              details={
                <>
                  <p>
                    One email per cancellation, written from scratch. Sent
                    with your name on the From line, from our verified
                    sending domain.
                  </p>
                  <p>
                    When a subscriber replies, the same AI reads it &mdash;
                    new context (they changed their mind, clarified a reason,
                    pushed back) flows back in and tunes the next move. You
                    see the reply and the updated classification in your
                    Winback dashboard.
                  </p>
                </>
              }
            />
            </RevealOnScroll>
          </div>

          <div className="mt-6 flex justify-center">
            <PoweredByStripe />
          </div>

          {/* CTA repeat */}
          <div className="mt-16 flex justify-center">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              Start recovering customers today →
            </Link>
          </div>
        </div>
      </section>

      {/* Section 3a — Card recovery (dunning) */}
      <section className="bg-white py-20 sm:py-24 border-t border-slate-100">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <RevealOnScroll>
            <div className="inline-flex items-center justify-center bg-blue-50 rounded-2xl w-12 h-12 mb-5">
              <CreditCard className="w-5 h-5 text-blue-600" />
            </div>
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              And when cards fail
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
              Failed payments, quietly recovered.
            </h2>
            <p className="text-base sm:text-lg text-slate-500 mt-5 max-w-2xl mx-auto leading-relaxed">
              Cards expire. Banks decline. Customers replace a stolen card and
              forget to tell you. The moment a payment fails, Winback emails
              the customer a one-click link to update it &mdash; before the
              retry window closes and the subscription is gone. One short
              email per failure, in the same dashboard as your cancellations.
            </p>
          </RevealOnScroll>
        </div>
      </section>

      {/* Section 3b — Dashboard proof */}
      <section className="bg-[#f5f5f5] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6">
          <RevealOnScroll>
            <div className="text-center mb-10">
              <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
                Your dashboard
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
                Every recovery, tracked.
              </h2>
              <p className="text-base sm:text-lg text-slate-500 mt-4 max-w-2xl mx-auto">
                See who cancelled, why they left, what Winback sent, and who came back — all in one view.
              </p>
            </div>
            <div className="rounded-2xl overflow-hidden shadow-lg border border-slate-200/60">
              <Image
                src="/demo-dashboard.png"
                alt="Winback dashboard showing recovered subscribers, recovery rate, and MRR recovered"
                width={1200}
                height={750}
                className="w-full h-auto"
              />
            </div>
          </RevealOnScroll>
        </div>
      </section>

      {/* Section 4 — Pricing */}
      <section id="pricing" className="bg-[#f5f5f5] py-24 sm:py-32">
        <div className="max-w-3xl mx-auto px-6">
          <div className="text-center">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              Pricing
            </div>
            <h2 className="mt-6 text-4xl sm:text-5xl font-bold text-slate-900 tracking-tight leading-[1.1]">
              No win-back,<br />no performance fee.
            </h2>
            <p className="mt-5 text-base text-slate-600 max-w-lg mx-auto">
              Pay $99/mo for the platform — unlimited card saves included. The
              performance fee only earns when we bring a cancelled subscriber back.
            </p>
          </div>

          {/* Pricing card — two-fee structure */}
          <div className="mt-12 bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-slate-100">
              <div className="p-8">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400">
                  Platform
                </div>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-5xl font-bold text-slate-900 tracking-tight">$99</span>
                  <span className="text-sm text-slate-500">/mo</span>
                </div>
                <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                  Flat. Includes unlimited card saves — one or a thousand, same price.
                </p>
              </div>

              <div className="p-8 bg-slate-50/50">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-blue-600">
                  Performance
                </div>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-5xl font-bold text-slate-900 tracking-tight">1×</span>
                  <span className="text-sm text-slate-500">MRR · once per win-back</span>
                </div>
                <p className="mt-3 text-sm text-slate-600 leading-relaxed">
                  Charged only when a cancelled subscriber comes back. 14-day refund if
                  they re-cancel.
                </p>
              </div>
            </div>

            <div className="border-t border-slate-100" />

            <div className="p-8">
              <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400 mb-5">
                What&apos;s included
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Under 60 seconds</strong> from cancel to email
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">AI-written per subscriber</strong>, not templated
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Changelog-aware</strong> — re-engages when you ship
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Replies route to your dashboard</strong>
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Unlimited card saves</strong> when payments fail
                  </span>
                </div>
                <div className="flex gap-2.5">
                  <span className="text-blue-600 font-bold">→</span>
                  <span className="text-slate-700">
                    <strong className="text-slate-900">Live in 5 minutes</strong> — connect Stripe
                  </span>
                </div>
              </div>
            </div>

            <div className="px-8 pb-8 flex flex-col sm:flex-row sm:items-center gap-4 border-t border-slate-100 pt-6">
              <Link
                href="/register"
                className="bg-[#0f172a] text-white rounded-full px-6 py-3 text-sm font-medium hover:bg-[#1e293b] inline-flex items-center gap-2"
              >
                Start recovering revenue →
              </Link>
              <p className="text-xs text-slate-500">
                No card at signup. Billing starts after your first save or win-back.
              </p>
            </div>
          </div>

          {/* Worked example with ROI */}
          <div className="mt-10 rounded-2xl bg-white border border-slate-200 overflow-hidden">
            <div className="px-6 sm:px-8 py-5 border-b border-slate-100 flex items-baseline justify-between">
              <div className="text-[11px] font-semibold tracking-widest uppercase text-blue-600">
                A typical month
              </div>
              <div className="text-xs text-slate-400">Sub MRR: $25 avg</div>
            </div>
            <dl className="text-sm">
              <div className="flex justify-between px-6 sm:px-8 py-4 border-b border-slate-100">
                <dt className="text-slate-700">Platform fee</dt>
                <dd className="text-slate-900 font-medium tabular-nums">$99</dd>
              </div>
              <div className="flex justify-between px-6 sm:px-8 py-4 border-b border-slate-100">
                <dt className="text-slate-700">40 card saves</dt>
                <dd className="text-green-700 font-medium">included</dd>
              </div>
              <div className="flex justify-between px-6 sm:px-8 py-4 border-b border-slate-100">
                <dt className="text-slate-700">
                  3 cancellers won back <span className="text-slate-400">($25 × 3)</span>
                </dt>
                <dd className="text-slate-900 font-medium tabular-nums">$75</dd>
              </div>
              <div className="flex justify-between px-6 sm:px-8 py-5 bg-slate-50">
                <dt className="text-slate-900 font-semibold">You pay this month</dt>
                <dd className="text-slate-900 font-bold text-base tabular-nums">$174</dd>
              </div>
            </dl>

            <div className="px-6 sm:px-8 py-6 bg-gradient-to-br from-blue-50 to-blue-50/40 border-t border-blue-100">
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <div className="text-[11px] font-semibold tracking-widest uppercase text-blue-700">
                    If those 3 stay 12 months
                  </div>
                  <div className="mt-1 text-sm text-slate-600">$25 × 3 × 12 months recovered</div>
                </div>
                <div className="text-right">
                  <div className="text-3xl font-bold text-slate-900 tabular-nums">$900</div>
                  <div className="text-xs text-slate-500">kept revenue</div>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-blue-200/60 flex items-baseline justify-between gap-4">
                <div className="text-sm text-slate-700">Return on the $75 win-back fee</div>
                <div className="text-2xl font-bold text-blue-700 tabular-nums">12×</div>
              </div>
            </div>
          </div>

          <p className="mt-3 text-xs text-slate-400 italic px-1">
            Card-save revenue not included above.
          </p>

          {/* Scale strip — same model at other business sizes */}
          <div className="mt-6 text-[11px] font-semibold tracking-widest uppercase text-slate-400 px-1">
            And at other scales
          </div>
          <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Indie */}
            <div className="rounded-xl bg-white border border-slate-200 p-5">
              <div className="flex items-baseline justify-between">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400">Indie</div>
                <div className="text-xs text-slate-500 tabular-nums">$19 MRR</div>
              </div>
              <div className="mt-1 text-xs text-slate-500">2 win-backs · 25 saves</div>
              <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">Monthly</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900 tabular-nums">$137</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$99 + 2 × $19</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">12-mo recovered</div>
                  <div className="mt-0.5 text-lg font-bold text-blue-700 tabular-nums">$456</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$19 × 2 × 12</div>
                </div>
              </div>
            </div>

            {/* SMB — highlighted, mirrors the hero example above */}
            <div className="rounded-xl bg-white border-2 border-blue-200 p-5">
              <div className="flex items-baseline justify-between">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-blue-700">SMB · shown above</div>
                <div className="text-xs text-slate-500 tabular-nums">$25 MRR</div>
              </div>
              <div className="mt-1 text-xs text-slate-500">3 win-backs · 40 saves</div>
              <div className="mt-4 pt-4 border-t border-blue-100 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">Monthly</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900 tabular-nums">$174</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$99 + 3 × $25</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">12-mo recovered</div>
                  <div className="mt-0.5 text-lg font-bold text-blue-700 tabular-nums">$900</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$25 × 3 × 12</div>
                </div>
              </div>
            </div>

            {/* Mid-market */}
            <div className="rounded-xl bg-white border border-slate-200 p-5">
              <div className="flex items-baseline justify-between">
                <div className="text-[11px] font-semibold tracking-widest uppercase text-slate-400">Mid-market</div>
                <div className="text-xs text-slate-500 tabular-nums">$89 MRR</div>
              </div>
              <div className="mt-1 text-xs text-slate-500">4 win-backs · 30 saves</div>
              <div className="mt-4 pt-4 border-t border-slate-100 grid grid-cols-2 gap-3">
                <div>
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">Monthly</div>
                  <div className="mt-0.5 text-lg font-bold text-slate-900 tabular-nums">$455</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$99 + 4 × $89</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider">12-mo recovered</div>
                  <div className="mt-0.5 text-lg font-bold text-blue-700 tabular-nums">$4,272</div>
                  <div className="text-[10px] text-slate-400 tabular-nums">$89 × 4 × 12</div>
                </div>
              </div>
            </div>
          </div>

          {/* Trust strip */}
          <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-x-8 gap-y-3 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className="text-green-600">✓</span> Cancel anytime
            </span>
            <span className="text-slate-300 hidden sm:inline">·</span>
            <span className="flex items-center gap-1.5">
              <span className="text-green-600">✓</span> 14-day refund on performance fee
            </span>
            <span className="text-slate-300 hidden sm:inline">·</span>
            <span className="flex items-center gap-1.5">
              <span className="text-green-600">✓</span> No setup fees
            </span>
          </div>

          <div className="mt-10 text-center">
            <Link href="/pricing" className="text-sm text-blue-600 font-medium hover:text-blue-700">
              See full pricing ›
            </Link>
          </div>

          {/* Fixed-contract alternative — for teams that need predictable
              budgeting (SSO + signed SLA) instead of the performance model. */}
          <div className="mt-12 max-w-xl mx-auto pt-10 border-t border-slate-200 text-center">
            <h3 className="text-sm font-semibold text-slate-900">
              Need a fixed annual contract?
            </h3>
            <p className="mt-3 text-sm text-slate-500 leading-relaxed">
              For teams that need predictable budgeting with SSO and a signed SLA —
              we offer fixed annual contracts as an alternative to the performance model.
            </p>
            <a
              href="mailto:sales@winbackflow.co"
              className="mt-4 inline-block text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              sales@winbackflow.co →
            </a>
          </div>
        </div>
      </section>

      {/* Section 5 — Footer CTA */}
      <section className="bg-[#eef2fb] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-violet-600">
            Powered by AI tuned for retention
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
            Connect Stripe. Stop the leak.
          </h2>

          <div className="mt-8">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              Start recovering today →
            </Link>
          </div>

          <p className="mt-6 text-sm text-slate-500">
            Free until we deliver your first save or win-back.
          </p>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-start justify-between gap-6 text-xs text-slate-500">
          <div className="leading-relaxed">
            <div>© {new Date().getFullYear()} Winback Ltd · Company no. {'{TO_FILL}'}</div>
            <div>{'{Registered office address — pending incorporation}'}</div>
            <div>
              <a href="mailto:support@winbackflow.co" className="hover:text-slate-900">
                support@winbackflow.co
              </a>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Link href="/pricing" className="hover:text-slate-900">Pricing</Link>
            <Link href="/faq" className="hover:text-slate-900">FAQ</Link>
            <Link href="/contact" className="hover:text-slate-900">Contact</Link>
            <Link href="/refunds" className="hover:text-slate-900">Refunds</Link>
            <Link href="/aup" className="hover:text-slate-900">Acceptable Use</Link>
            <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms</Link>
            <Link href="/dpa" className="hover:text-slate-900">DPA</Link>
            <Link href="/subprocessors" className="hover:text-slate-900">Subprocessors</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}

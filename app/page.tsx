import Link from 'next/link'
import { PricingCalculator } from '@/components/pricing-calculator'
import { PoweredByStripe } from '@/components/powered-by-stripe'
import { StickyNav } from '@/components/landing/sticky-nav'
import { HeroDemoToggle } from '@/components/landing/hero-demo-toggle'
import { StepCard } from '@/components/landing/step-card'
import { RevealOnScroll } from '@/components/landing/reveal-on-scroll'
import { Zap, Brain, Send, CheckCircle } from 'lucide-react'

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

          <HeroDemoToggle />
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

      {/* Section 4 — Pricing */}
      <section id="pricing" className="bg-[#f5f5f5] py-24 sm:py-32">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Pricing
          </div>

          <h2 className="mt-6 text-4xl sm:text-5xl font-bold text-slate-900 tracking-tight">
            15% of recovered subscription revenue.
          </h2>

          <p className="mt-5 text-base sm:text-lg text-slate-600 max-w-xl mx-auto leading-relaxed">
            of what we bring back — for{' '}
            <strong className="text-slate-900 font-semibold">
              12 months per recovered subscriber
            </strong>
            . After that, it&apos;s yours forever.
          </p>

          <PricingCalculator />

          <div className="mt-10 text-sm text-slate-600">
            <p className="font-medium text-slate-900">
              Your fee is always less than what we recover.
            </p>
            <p className="text-slate-500 mt-1">
              If we recover nothing, you pay nothing.
            </p>
          </div>

          <div className="mt-10 flex flex-col items-center gap-3">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              See it on your own customers →
            </Link>
            <p className="text-xs text-slate-400 max-w-md">
              No card at signup. We ask for payment after your first recovery.
            </p>
          </div>

          <ul className="mt-16 max-w-2xl mx-auto text-left space-y-4">
            <li className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-slate-600">
                <strong className="text-slate-900 font-semibold">One rate, always.</strong>{' '}
                15% whether you recover £50 or £5,000. No tier games.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-slate-600">
                <strong className="text-slate-900 font-semibold">Attribution stops at 12 months.</strong>{' '}
                After that, recovered subscribers are fully yours.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
              <span className="text-sm text-slate-600">
                <strong className="text-slate-900 font-semibold">No base fee.</strong>{' '}
                Zero cost unless we&apos;re actively recovering revenue for you.
              </span>
            </li>
          </ul>

          <div className="mt-10">
            <Link href="/pricing" className="text-sm text-blue-600 font-medium hover:text-blue-700">
              See full pricing ›
            </Link>
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
            Free to start. Pay only when we recover.
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
            No card at signup. Pay only when we recover.
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

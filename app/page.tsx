import Link from 'next/link'
import { Logo } from '@/components/logo'
import { PricingCalculator } from '@/components/pricing-calculator'
import { Zap, CheckCircle } from 'lucide-react'

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Section 1 — Navigation */}
      <nav className="pt-4 px-6">
        <div className="max-w-5xl mx-auto bg-white rounded-full px-6 flex items-center justify-between h-14 shadow-sm border border-slate-100">
          <Logo />
          <div className="flex items-center gap-6">
            <a href="#how-it-works" className="text-slate-600 text-sm">
              How it works
            </a>
            <a href="#pricing" className="text-slate-600 text-sm">
              Pricing
            </a>
            <Link href="/faq" className="text-slate-600 text-sm">
              FAQ
            </Link>
            <Link href="/login" className="text-slate-600 text-sm">
              Log in
            </Link>
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
            >
              Sign up &rarr;
            </Link>
          </div>
        </div>
      </nav>

      {/* Section 2 — Hero */}
      <section className="bg-[#eef2fb] py-24">
        <div className="max-w-5xl mx-auto px-6 flex flex-col items-center">
          <div className="bg-white border border-slate-200 rounded-full px-4 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-widest">
            NEW &middot; AI WIN-BACK
          </div>

          <h1 className="mt-8">
            <span className="block text-6xl font-bold text-slate-900 text-center tracking-tight">
              Win<span className="text-green-500">back</span> lost customers.
            </span>
            <span className="block text-6xl font-bold text-slate-400 text-center tracking-tight">
              Automatically.
            </span>
          </h1>

          <p className="mt-6 text-lg text-slate-500 max-w-2xl text-center leading-relaxed">
            The moment a customer cancels, Winback sends a personalised email
            &mdash; grounded in what you&apos;ve delivered recently, their
            subscription history, and any reason they shared for leaving.
          </p>

          <div className="flex items-center gap-4 mt-8">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
            >
              Get started &rarr;
            </Link>
            <a
              href="#how-it-works"
              className="text-blue-600 font-medium text-sm"
            >
              How it works &rsaquo;
            </a>
          </div>

          <p className="mt-4 text-sm text-slate-400 text-center">
            15% of recovered revenue, for 12 months. No card at signup.
          </p>

          {/* Demo card */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 max-w-lg mx-auto mt-12 w-full">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
                  Cancellation
                </div>
                <div className="font-bold text-slate-900 text-sm">
                  Sarah K. cancelled Pro
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  £24.99/mo &middot; 0.4s ago
                </div>
              </div>
              <div className="bg-slate-100 rounded-xl w-9 h-9 flex items-center justify-center">
                <Zap className="w-4 h-4 text-blue-600" />
              </div>
            </div>
            <div className="bg-green-50 rounded-xl p-3 mt-4 flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-green-600" />
              <span className="text-sm font-medium text-green-700">
                Winback email sent &middot; Resubscribed in 2 days
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Section 3 — How it works */}
      <section id="how-it-works" className="bg-white py-24">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              How it works
            </div>
            <h2 className="text-4xl font-bold text-slate-900 mt-3">
              Three steps.
            </h2>
            <h2 className="text-4xl font-bold text-slate-900">
              Zero manual work.
            </h2>
            <p className="text-lg text-slate-500 mt-4 max-w-2xl mx-auto text-center">
              From cancellation to recovery in under a minute &mdash; without
              you touching a thing.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-16">
            {/* Step 01 */}
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">
                Step 01
              </div>
              <h3 className="text-lg font-bold text-slate-900">Detect</h3>
              <p className="text-sm text-slate-500 mt-1 mb-4">
                Every cancellation. Instantly.
              </p>
              <p className="text-sm text-slate-600 leading-relaxed">
                One click connects Stripe. From then on, every cancellation
                flows in the moment it happens &mdash; with the customer, the
                plan, the revenue, and any reason they gave.
              </p>
              <div className="bg-slate-50 rounded-xl p-4 mt-4 border border-slate-100">
                <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">
                  Cancellation
                </div>
                <div className="space-y-1.5 text-xs text-slate-600">
                  <div><span className="text-slate-400">Customer</span> Sarah K.</div>
                  <div><span className="text-slate-400">Plan</span> Pro &middot; £24.99/mo</div>
                  <div><span className="text-slate-400">Tenure</span> 8 months</div>
                  <div className="text-slate-400 mt-2">Received 0.4 seconds ago</div>
                </div>
              </div>
            </div>

            {/* Step 02 */}
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">
                Step 02
              </div>
              <h3 className="text-lg font-bold text-slate-900">Decide</h3>
              <p className="text-sm text-slate-500 mt-1 mb-4">
                The right message. For the right reason.
              </p>
              <p className="text-sm text-slate-600 leading-relaxed">
                Winback reads each cancellation reason and picks the response
                that matches &mdash; accountability when it&apos;s a quality
                issue, education when they missed a feature, a genuine update
                when things have changed.
              </p>
              <div className="bg-slate-50 rounded-xl p-4 mt-4 border border-slate-100">
                <div className="text-xs text-slate-400 mb-2">Cancellation reason</div>
                <div className="text-sm text-slate-900 font-medium mb-3">
                  &ldquo;Missing the calendar integration I need&rdquo;
                </div>
                <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">
                  WINBACK CHOOSES
                </div>
                <div className="space-y-1.5 text-xs text-slate-600">
                  <div><span className="text-slate-400">Tone</span> Empathetic + informative</div>
                  <div><span className="text-slate-400">Content</span> Feature roadmap update</div>
                  <div><span className="text-slate-400">Channel</span> Personal email</div>
                </div>
              </div>
            </div>

            {/* Step 03 */}
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">
                Step 03
              </div>
              <h3 className="text-lg font-bold text-slate-900">Act</h3>
              <p className="text-sm text-slate-500 mt-1 mb-4">
                Sent automatically. From your real inbox.
              </p>
              <p className="text-sm text-slate-600 leading-relaxed">
                Emails go from your own Gmail, signed with your name. No generic
                no-reply. Replies come straight back to you &mdash; which is
                what turns a winback into a conversation.
              </p>
              <div className="bg-slate-50 rounded-xl p-4 mt-4 border border-slate-100">
                <div className="space-y-1.5 text-xs text-slate-600">
                  <div><span className="text-slate-400">From</span> alex@yourcompany.com</div>
                  <div><span className="text-slate-400">To</span> sarah.k@gmail.com</div>
                  <div><span className="text-slate-400">Subject</span> Quick update from us</div>
                  <div className="text-slate-400 mt-2 leading-relaxed">
                    Hi Sarah, I noticed you cancelled your Pro plan. I wanted to
                    reach out personally because&hellip;
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Section 4 — Pricing */}
      <section id="pricing" className="bg-white py-32 sm:py-40">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Pricing
          </div>

          <h2 className="mt-6 text-4xl sm:text-5xl font-bold text-slate-900 tracking-tight">
            15% of recovered revenue.
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
              Get started &rarr;
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
              See full pricing &rsaquo;
            </Link>
          </div>
        </div>
      </section>

      {/* Section 5 — Footer CTA */}
      <section className="bg-[#eef2fb] py-24">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Ready to recover?
          </div>
          <h2 className="text-4xl font-bold text-slate-900 mt-3">
            Connect Stripe in two clicks.
          </h2>
          <h2 className="text-4xl font-bold text-slate-900">
            Free to start. Pay only when we recover.
          </h2>

          <div className="mt-8">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
            >
              Get started
            </Link>
          </div>

          <p className="mt-6 text-sm text-slate-400">
            15% of recovered revenue, for 12 months per subscriber.
            <br />
            No base fee. No card at signup.
          </p>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div>© {new Date().getFullYear()} Winback Ltd</div>
          <nav className="flex items-center gap-5">
            <Link href="/pricing" className="hover:text-slate-900">Pricing</Link>
            <Link href="/faq" className="hover:text-slate-900">FAQ</Link>
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

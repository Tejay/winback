import Link from 'next/link'
import { Logo } from '@/components/logo'
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
            NEW &middot; AI CHURN RECOVERY
          </div>

          <h1 className="mt-8">
            <span className="block text-6xl font-bold text-slate-300 text-center">
              Win<span className="text-green-400">back</span> lost customers.
            </span>
            <span className="block text-6xl font-bold text-blue-400 text-center">
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
            Free first recovery. Then &pound;49/mo + 10% of what we win back.
          </p>

          {/* Demo card */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 max-w-lg mx-auto mt-12 w-full">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1">
                  STRIPE EVENT
                </div>
                <div className="font-mono font-bold text-slate-900 text-sm">
                  customer.subscription.deleted
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Sarah K. &middot; Pro &middot; $24.99/mo
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
                One OAuth click connects Stripe. From then on, every
                subscription.deleted event flows in the moment it happens &mdash;
                with the customer, the MRR, the plan, and the reason they gave.
              </p>
              <div className="bg-slate-50 rounded-xl p-4 mt-4 border border-slate-100">
                <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">
                  STRIPE EVENT
                </div>
                <div className="space-y-1.5 text-xs text-slate-600">
                  <div><span className="text-slate-400">Customer</span> Sarah K.</div>
                  <div><span className="text-slate-400">Plan</span> Pro &middot; $24.99/mo</div>
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

      {/* Section 4 — Footer CTA */}
      <section className="bg-[#eef2fb] py-24">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Ready to recover?
          </div>
          <h2 className="text-4xl font-bold text-slate-900 mt-3">
            Connect Stripe in two clicks.
          </h2>
          <h2 className="text-4xl font-bold text-slate-900">
            Your first recovery is on us.
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
            Free until your first recovery.
            <br />
            Then &pound;49/mo + 10% of recovered revenue
            <br />
            &mdash; first year each subscriber stays back.
            <br />
            No card required.
          </p>
        </div>
      </section>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div>© {new Date().getFullYear()} Winback Ltd</div>
          <nav className="flex items-center gap-5">
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

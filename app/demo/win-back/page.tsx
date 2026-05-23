import Link from 'next/link'
import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { WinBackDemoDashboard } from '@/components/demo/demo-dashboard'

export const metadata = {
  title: 'Cancellation winbacks dashboard demo — Winback',
  description:
    'See exactly what the WinbackFlow dashboard looks like with realistic data — pipeline, KPIs, cancellation themes ranked by lost MRR, and the per-subscriber detail drawer.',
}

export default function WinBackDemoPage() {
  return (
    <div className="min-h-screen bg-white">
      <StickyNav />

      {/* Hero — headline + subhead */}
      <section className="bg-[#eef2fb] py-14 sm:py-16">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Cancellation winbacks · Dashboard preview
          </div>
          <h1 className="mt-3 text-3xl sm:text-5xl font-bold text-slate-900 tracking-tight leading-[1.1] max-w-3xl">
            See the reasons. Ship the fixes. Reach the right people.
          </h1>
          <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
            Every cancellation lands here with its reason classified into a
            theme. The themes are ranked by lost MRR &mdash; so you can see
            what to build next, by dollars at risk. When you ship a fix,
            WinbackFlow emails the specific subscribers who cited it.
          </p>
          <p className="mt-3 text-sm text-slate-500 max-w-2xl">
            This is the dashboard you&rsquo;ll see five minutes after
            connecting Stripe.
          </p>
          <p className="mt-2 text-xs text-slate-400 italic max-w-2xl">
            Numbers shown are illustrative. Your actual results will depend on
            your business, your customers, and your traffic.
          </p>
        </div>
      </section>

      {/* Dashboard */}
      <section className="py-10 sm:py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <WinBackDemoDashboard />
        </div>
      </section>

      {/* "How to read this" caption */}
      <section className="pb-10 sm:pb-14">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-xs font-semibold tracking-widest uppercase text-slate-400 mb-3">
            How to read this
          </div>
          <ul className="space-y-3 text-sm text-slate-600 leading-relaxed">
            <li>
              <strong className="text-slate-900">Pipeline strip</strong> (top): how much MRR is at risk in the last 30
              days, how much has already been recovered, how much is still
              in play, and how much is gone. The in-flight number is
              what&rsquo;s still possible.
            </li>
            <li>
              <strong className="text-slate-900">Top reasons</strong> (above the table): the cancellation
              categories driving churn, ranked by share &mdash; so you can
              see at a glance whether it&rsquo;s mostly Price, Feature
              gaps, or Switching.
            </li>
            <li>
              <strong className="text-slate-900">Status column</strong>: each open row gets a recovery-likelihood
              chip &mdash; <span className="font-medium text-emerald-700">High</span>,
              <span className="font-medium text-amber-700"> Medium</span>, or
              <span className="font-medium text-slate-500"> Low</span> &mdash; based
              on signals from their reason, plan, and tenure. Recovered
              subscribers flip to a <span className="font-medium text-emerald-700">✓ Recovered</span> chip.
            </li>
            <li>
              <strong className="text-slate-900">Awaiting reply</strong>: an amber dot before a subscriber&rsquo;s
              avatar signals the ball&rsquo;s in your court &mdash; they
              replied to your last email and the conversation needs you.
              The first line of their reply shows under their name.
            </li>
          </ul>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-[#0f172a] text-white py-14 sm:py-16">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Want this for your business?
          </h2>
          <p className="mt-3 text-slate-300">
            Connect Stripe in two minutes. No card at signup. You pay nothing
            until we deliver your first recovery or cancellation winback.
          </p>
          <div className="mt-7 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/register"
              className="bg-white text-[#0f172a] rounded-full px-6 py-3 text-sm font-semibold hover:bg-slate-100 transition-colors"
            >
              Start free →
            </Link>
            <Link
              href="/demo/payment-recovery"
              className="text-slate-300 hover:text-white text-sm font-medium px-4 py-3"
            >
              Explore the payment recovery dashboard →
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

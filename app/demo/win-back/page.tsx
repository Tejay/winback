import Link from 'next/link'
import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { WinBackDemoDashboard } from '@/components/demo/demo-dashboard'

export const metadata = {
  title: 'Win-back dashboard demo — Winback',
  description:
    'See exactly what a Winback dashboard looks like with realistic data — KPIs, the loss-framing pipeline, and the per-subscriber drawer with AI reasoning.',
}

export default function WinBackDemoPage() {
  return (
    <div className="min-h-screen bg-white">
      <StickyNav />

      {/* Hero — headline + subhead */}
      <section className="bg-[#eef2fb] py-14 sm:py-16">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Win-backs · Live dashboard demo
          </div>
          <h1 className="mt-3 text-3xl sm:text-5xl font-bold text-slate-900 tracking-tight leading-[1.1] max-w-3xl">
            Every cancellation. Every chance to win them back.
          </h1>
          <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
            See exactly what&rsquo;s at risk, what we&rsquo;re working on, and
            what we&rsquo;ve recovered &mdash; with the AI&rsquo;s reasoning
            behind every decision.
          </p>
          <p className="mt-3 text-sm text-slate-500 max-w-2xl">
            This is the dashboard you&rsquo;ll see five minutes after
            connecting Stripe. Realistic data shown &mdash; your numbers will
            look like this within your first month.
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
              <strong className="text-slate-900">Pipeline strip</strong> (top): of the $9,420 you&rsquo;d lose this
              month to cancellations, $4,820 is already recovered, $3,200 is
              still in play, only $1,400 lost.
            </li>
            <li>
              <strong className="text-slate-900">Drawer</strong> (right): every cancellation is classified by reason,
              scored for recovery likelihood, and surfaced with a draft
              response &mdash; you act, we don&rsquo;t pretend the AI is the
              founder.
            </li>
            <li>
              <strong className="text-slate-900">Handoff alert</strong> (top, amber): when AI decides your personal
              touch matters more than another email, it routes the case to
              your inbox within 60 seconds of the cancellation.
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
            until we deliver your first recovery or win-back.
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
              See payment recovery demo →
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

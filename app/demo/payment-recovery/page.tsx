import Link from 'next/link'
import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { PaymentRecoveryDemoDashboard } from '@/components/demo/demo-dashboard'

export const metadata = {
  title: 'Payment recovery dashboard demo — Winback',
  description:
    'See exactly what the payment recovery dashboard looks like with realistic data — pipeline at risk, retry stages, decline codes, and one-click resend.',
}

export default function PaymentRecoveryDemoPage() {
  return (
    <div className="min-h-screen bg-white">
      <StickyNav />

      {/* Hero */}
      <section className="bg-emerald-50 py-14 sm:py-16">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-xs font-semibold tracking-widest uppercase text-emerald-700">
            Payment recovery · Live dashboard demo
          </div>
          <h1 className="mt-3 text-3xl sm:text-5xl font-bold text-slate-900 tracking-tight leading-[1.1] max-w-3xl">
            Failed payments don&rsquo;t have to mean lost customers.
          </h1>
          <p className="mt-4 text-base sm:text-lg text-slate-600 max-w-2xl leading-relaxed">
            Track every failed charge, every retry, every recovery &mdash; and
            let us nudge customers to update their card before Stripe gives up.
          </p>
          <p className="mt-3 text-sm text-slate-500 max-w-2xl">
            Stripe recovers some failed payments on its own; we recover the
            rest &mdash; silently, in the background, no per-recovery fee.
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
          <PaymentRecoveryDemoDashboard />
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
              <strong className="text-slate-900">Pipeline strip</strong> (top): see total failed-payment MRR in the
              last 30 days, how much has already been saved, how much is in
              active retry, and how much was lost. Failed payments are
              involuntary &mdash; the customer wanted to stay, their card
              just broke &mdash; so most can be recovered.
            </li>
            <li>
              <strong className="text-slate-900">Decline codes</strong> (pattern strip): the top reasons cards fail in
              your business. <code className="font-mono text-xs">insufficient_funds</code> and{' '}
              <code className="font-mono text-xs">expired_card</code> together
              are usually &gt;80% &mdash; both are recoverable.
            </li>
            <li>
              <strong className="text-slate-900">In-place expansion</strong>: click any row to see the full retry
              timeline, the decline code from the bank, and one button to
              resend the update-payment email if you want to nudge them
              manually.
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
              href="/demo/win-back"
              className="text-slate-300 hover:text-white text-sm font-medium px-4 py-3"
            >
              See win-back demo →
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

import Link from 'next/link'
import { Logo } from '@/components/logo'
import { PricingCalculator } from '@/components/pricing-calculator'
import { CheckCircle } from 'lucide-react'

export const metadata = { title: 'Pricing — Winback' }

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <nav className="pt-4 px-6">
        <div className="max-w-5xl mx-auto bg-white rounded-full px-6 flex items-center justify-between h-14 shadow-sm border border-slate-100">
          <Logo />
          <div className="flex items-center gap-6">
            <Link href="/" className="text-slate-600 text-sm">Home</Link>
            <Link href="/login" className="text-slate-600 text-sm">Log in</Link>
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium hover:bg-[#1e293b]"
            >
              Sign up &rarr;
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1 py-32 sm:py-40">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Pricing
          </div>

          <div className="mt-10 flex items-baseline justify-center gap-4">
            <span className="text-[120px] sm:text-[160px] leading-none font-semibold tracking-tighter text-slate-900">
              15<span className="text-slate-300">%</span>
            </span>
            <span className="text-xl sm:text-2xl text-slate-400 font-medium">
              of recovered revenue
            </span>
          </div>

          <p className="mt-8 text-base sm:text-lg text-slate-600 max-w-xl mx-auto leading-relaxed">
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

          <div className="mt-16 max-w-2xl mx-auto text-left">
            <div className="text-xs font-semibold uppercase tracking-widest text-slate-400 pb-3 border-b border-slate-200">
              Effective rate — always 15%
            </div>
            <dl className="divide-y divide-slate-100 text-sm">
              {[
                ['£100 recovered', '£15 fee — 15%'],
                ['£500 recovered', '£75 fee — 15%'],
                ['£1,000 recovered', '£150 fee — 15%'],
                ['£5,000 recovered', '£750 fee — 15%'],
                ['£0 recovered', '£0 fee — nothing owed'],
              ].map(([left, right]) => (
                <div key={left} className="flex items-center justify-between py-3">
                  <dt className="text-slate-600">{left}</dt>
                  <dd className="text-green-600 font-medium tabular-nums">{right}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
          <div>© {new Date().getFullYear()} Winback Ltd</div>
          <nav className="flex items-center gap-5">
            <Link href="/pricing" className="hover:text-slate-900">Pricing</Link>
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

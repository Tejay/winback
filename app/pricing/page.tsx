import Link from 'next/link'
import { Logo } from '@/components/logo'

export const metadata = { title: 'Pricing — Winback' }

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col">
      <nav className="pt-4 px-6">
        <div className="max-w-5xl mx-auto bg-white rounded-full px-6 flex items-center justify-between h-14 shadow-sm border border-slate-100">
          <Link href="/">
            <Logo />
          </Link>
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
          <h1 className="mt-8 text-5xl sm:text-6xl font-semibold tracking-tight text-slate-900">
            One price. One moment.
          </h1>
          <p className="mt-6 text-lg text-slate-500 leading-relaxed">
            Winback is free until we recover a customer for you.
          </p>

          <div className="mt-24 sm:mt-28">
            <div className="text-[140px] sm:text-[200px] leading-none font-semibold tracking-tighter text-slate-900">
              25<span className="text-slate-300">%</span>
            </div>
            <p className="mt-10 text-lg sm:text-xl text-slate-600 max-w-xl mx-auto leading-relaxed">
              of the first month of every subscription we bring back.
            </p>
            <p className="mt-4 text-sm text-slate-400">
              That&apos;s it. No monthly fee. No setup fee. No contracts.
            </p>
          </div>

          <div className="mt-24 flex flex-col items-center gap-4">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              Get started
            </Link>
            <p className="text-xs text-slate-400 max-w-md">
              No card required at sign-up. We ask for payment the first time
              Winback recovers a customer for you.
            </p>
          </div>

          <div className="mt-32 grid grid-cols-1 sm:grid-cols-3 gap-12 text-left">
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">
                How we charge
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">
                When a cancelled customer resubscribes after a Winback email,
                we charge 25% of their first month&rsquo;s MRR. Once.
              </p>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">
                Example
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">
                Customer comes back on a £99/mo plan. We charge you £24.75.
                Not next month. Not the month after. Once.
              </p>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">
                No win, no fee
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">
                If we don&rsquo;t recover anyone, you pay nothing. Not this
                month, not ever. Cancel any time.
              </p>
            </div>
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

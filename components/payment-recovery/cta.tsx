import Link from 'next/link'

/**
 * Final CTA on /payment-recovery. Pricing lives on the home page only
 * (combined billing for both flows), so this links there for pricing
 * and offers a direct connect-Stripe shortcut.
 */
export function Cta() {
  return (
    <section className="bg-[#eef2fb] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6 text-center">
        <div className="text-xs font-semibold tracking-widest uppercase text-violet-600">
          Ready to start?
        </div>
        <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
          Plug in. Stop the leak.
        </h2>
        <p className="mt-4 text-sm text-slate-600 max-w-xl mx-auto">
          Payment recovery is included in the platform fee — no per-save cut, no extras.{' '}
          <Link href="/#pricing" className="text-blue-600 hover:text-blue-700 font-medium">
            See full pricing →
          </Link>
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/register"
            className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
          >
            Connect Stripe in 60 seconds →
          </Link>
        </div>
        <p className="mt-6 text-xs text-slate-500">
          Stripe Connect Standard · No card at signup.
        </p>
      </div>
    </section>
  )
}

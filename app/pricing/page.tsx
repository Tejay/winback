import Link from 'next/link'
import { StickyNav } from '@/components/landing/sticky-nav'
import { PricingFormula } from '@/components/landing/pricing-formula'
import { Footer } from '@/components/landing/footer'

export const metadata = { title: 'Pricing — Winback' }

/**
 * Dedicated /pricing page. Reuses the same <PricingFormula /> the home page
 * shows, plus the "How billing works" FAQ that visitors looking specifically
 * for pricing depth tend to want. Single source of truth for the pricing
 * copy lives in components/landing/pricing-formula.tsx.
 */
export default function PricingPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />
      <PricingFormula />

      {/* How billing works — extra detail block, only on the dedicated /pricing page */}
      <section className="bg-[#f5f5f5] pb-24">
        <div className="max-w-2xl mx-auto px-6">
          <div className="text-xs font-semibold tracking-widest uppercase text-slate-400 pb-3 border-b border-slate-200">
            How billing works
          </div>
          <dl className="divide-y divide-slate-100 text-sm">
            <div className="py-4">
              <dt className="text-slate-900 font-medium">When does the $99 start?</dt>
              <dd className="mt-1 text-slate-600 leading-relaxed">
                After we deliver your first card save or win-back, whichever comes
                first. We don&apos;t bill the platform fee at signup — it kicks in
                once we&apos;ve actually saved you a dollar.
              </dd>
            </div>
            <div className="py-4">
              <dt className="text-slate-900 font-medium">How is the performance fee charged?</dt>
              <dd className="mt-1 text-slate-600 leading-relaxed">
                One invoice per win-back, equal to <strong>1 month&apos;s subscription fee</strong> for that subscriber. Charged once — never recurring. If they re-cancel within 14 days, we refund the fee in full.
              </dd>
            </div>
            <div className="py-4">
              <dt className="text-slate-900 font-medium">What counts as a win-back?</dt>
              <dd className="mt-1 text-slate-600 leading-relaxed">
                A subscriber who actively cancelled and then reactivated their
                subscription within our attribution window. Failed-payment recoveries
                are <em>not</em> win-backs — those are covered by the platform fee.
              </dd>
            </div>
            <div className="py-4">
              <dt className="text-slate-900 font-medium">What if no cancellations happen?</dt>
              <dd className="mt-1 text-slate-600 leading-relaxed">
                You still pay $99/mo — your card saves alone justify the platform
                fee. The performance fee just doesn&apos;t add anything that month.
                If neither saves nor cancellations happen, the $99 doesn&apos;t
                kick in until they do.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* Footer CTA — mirrors the bottom-bar CTAs on /payment-recovery + /win-back */}
      <section className="bg-[#eef2fb] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-violet-600">
            Ready to start?
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
            Free until your first save.
          </h2>
          <p className="mt-4 text-sm text-slate-600 max-w-xl mx-auto">
            Connect Stripe in 60 seconds. We don&apos;t bill the platform fee until we&apos;ve actually saved you a dollar — and the performance fee only earns when we recover a cancelled customer.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              Start free — no card →
            </Link>
          </div>
          <p className="mt-6 text-xs text-slate-500">
            Stripe Connect Standard · No card at signup.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  )
}

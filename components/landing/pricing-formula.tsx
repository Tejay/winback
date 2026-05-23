import Link from 'next/link'
import { Check } from 'lucide-react'

/**
 * Pricing — three tier cards + Enterprise contact-sales, one rail per
 * tier so the structure is impossible to misread.
 *
 * Structure-only rewrite (billing rewrite). Final copy is a separate
 * design pass; placeholder copy here keeps the page coherent and the
 * prices accurate. Per-tier benefits, comparison rows, and FAQ-tier
 * coverage are deferred.
 */
export function PricingFormula() {
  return (
    <section id="pricing" className="bg-white py-20 sm:py-24 border-t border-slate-100">
      <div className="max-w-5xl mx-auto px-6">
        {/* Section header */}
        <div className="text-center max-w-3xl mx-auto">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
            Pricing
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
            One flat monthly fee. Priced by your MRR.
          </h2>
          <p className="mt-4 text-sm sm:text-base text-slate-600">
            No per-recovery charges, no surprise invoices. Unlimited recovery
            volume on every tier. Free until we&apos;ve delivered your first
            recovered customer.
          </p>
        </div>

        {/* Tier grid — Starter / Growth / Scale / Enterprise */}
        <div className="mt-12 grid grid-cols-1 lg:grid-cols-4 gap-4">
          <TierCard
            tier="Starter"
            band="MRR up to $50k"
            price="$99"
            blurb="For early-stage SaaS finding their first cohort of paying customers."
            railClass="border-l-slate-400"
          />
          <TierCard
            tier="Growth"
            band="MRR $50k – $250k"
            price="$299"
            blurb="For teams scaling past product-market fit, fighting both churn and failed payments."
            railClass="border-l-blue-500"
            featured
          />
          <TierCard
            tier="Scale"
            band="MRR $250k – $1M"
            price="$699"
            blurb="For established subscription businesses with material recovery dollars on the line."
            railClass="border-l-emerald-500"
          />
          <TierCard
            tier="Enterprise"
            band="MRR $1M+"
            price="Contact us"
            blurb="Bespoke pricing, SLAs, and onboarding. Reach out and we&rsquo;ll tailor a contract."
            railClass="border-l-indigo-500"
            isEnterprise
          />
        </div>

        {/* Trust strip */}
        <div className="mt-10 rounded-2xl border border-slate-100 bg-slate-50/50 p-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm text-slate-700">
            <TrustItem>Free until your first recovered customer</TrustItem>
            <TrustItem>Unlimited recovery volume on every tier</TrustItem>
            <TrustItem>Cancel anytime — no retention friction</TrustItem>
          </div>
        </div>

        <div className="mt-8 text-center">
          <Link
            href="/pricing"
            className="inline-flex items-center justify-center text-sm font-medium text-blue-700 hover:text-blue-800"
          >
            See full pricing details →
          </Link>
        </div>
      </div>
    </section>
  )
}

function TierCard({
  tier,
  band,
  price,
  blurb,
  railClass,
  featured = false,
  isEnterprise = false,
}: {
  tier: string
  band: string
  price: string
  blurb: string
  railClass: string
  featured?: boolean
  isEnterprise?: boolean
}) {
  return (
    <div
      className={`rounded-2xl border ${
        featured ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-100'
      } shadow-sm p-6 border-l-4 ${railClass} bg-white`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
        {tier}
      </p>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-3xl font-bold text-slate-900 leading-none tabular-nums">
          {price}
        </span>
        {!isEnterprise && <span className="text-sm text-slate-500">/ mo</span>}
      </div>
      <p className="mt-2 text-xs font-medium text-slate-500">{band}</p>
      <p className="mt-3 text-sm text-slate-600 leading-relaxed">{blurb}</p>
    </div>
  )
}

function TrustItem({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Check className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" aria-hidden />
      <span className="leading-relaxed">{children}</span>
    </div>
  )
}

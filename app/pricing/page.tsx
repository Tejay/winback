import { TrackedCta } from '@/components/landing/tracked-cta'
import { Check } from 'lucide-react'
import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'

export const metadata = { title: 'Pricing — Winback' }

/**
 * /pricing — tiered MRR-based pricing.
 *
 * Structure-only rewrite (billing rewrite). The page wires the 4-tier
 * ladder (Starter / Growth / Scale / Enterprise) with placeholder
 * descriptions. Final copy, comparison-row matrix, FAQ rewrite, and
 * worked-ROI examples are deferred to a separate design + copy pass.
 *
 * What the new pricing page must convey (for the copy pass):
 *   - One flat monthly fee per tier, never per-recovery
 *   - Tier is assigned from the customer's own Stripe MRR
 *   - Free until we've delivered the first recovered customer
 *   - Unlimited recovery volume on every tier
 *   - Enterprise is sales-handled
 *   - Cancel anytime, no retention friction
 */
export default function PricingPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />

      <section id="pricing" className="bg-white py-20 sm:py-24 border-t border-slate-100">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center max-w-3xl mx-auto">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              Pricing
            </p>
            <h1 className="mt-3 text-3xl sm:text-4xl font-bold tracking-tight text-slate-900">
              One flat monthly fee. Priced by your MRR.
            </h1>
            <p className="mt-4 text-sm sm:text-base text-slate-600">
              No per-recovery charges. No surprise invoices. Free until we
              deliver your first recovered customer.
            </p>
            <p className="mt-3 text-xs text-slate-500">
              <strong className="font-semibold text-slate-600">MRR</strong> ={' '}
              Monthly Recurring Revenue.
            </p>
          </div>

          {/* Four tier cards */}
          <div className="mt-12 grid grid-cols-1 lg:grid-cols-4 gap-4">
            <TierCard
              tier="Starter"
              band="MRR up to $50k"
              price="$99"
              perMonth
              blurb="For early-stage SaaS finding their first cohort of paying customers."
              bullets={[
                'Unlimited recovery volume',
                'Both flows running (winback + payment recovery)',
                'Live dashboard with MRR and tier transparency',
              ]}
              railClass="border-l-slate-400"
            />
            <TierCard
              tier="Growth"
              band="MRR $50k – $250k"
              price="$299"
              perMonth
              featured
              blurb="For teams scaling past product-market fit, fighting both churn and failed payments."
              bullets={[
                'Everything in Starter',
                'Priority support',
                'Onboarding setup call',
              ]}
              railClass="border-l-blue-500"
            />
            <TierCard
              tier="Scale"
              band="MRR $250k – $1M"
              price="$699"
              perMonth
              blurb="For established subscription businesses with material recovery dollars on the line."
              bullets={[
                'Everything in Growth',
                'Quarterly strategy review (Zoom)',
                'Custom reporting on request',
              ]}
              railClass="border-l-emerald-500"
            />
            <TierCard
              tier="Enterprise"
              band="MRR $1M+"
              price="Contact us"
              blurb="Bespoke pricing, SLAs, and onboarding. Reach out and we&rsquo;ll tailor a contract."
              bullets={[
                'Everything in Scale',
                'Procurement-ready contract',
                'Dedicated account contact',
              ]}
              railClass="border-l-indigo-500"
              isEnterprise
            />
          </div>

          {/* Trust strip */}
          <div className="mt-10 rounded-2xl border border-slate-100 bg-slate-50/50 p-5">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-sm text-slate-700">
              <TrustItem>Free until first recovered customer</TrustItem>
              <TrustItem>Unlimited recovery volume on every tier</TrustItem>
              <TrustItem>Tier from your Stripe MRR — no self-reporting</TrustItem>
              <TrustItem>Cancel anytime — no retention friction</TrustItem>
            </div>
          </div>

          {/* How tier assignment works — the anti-dispute story */}
          <div className="mt-12 max-w-3xl mx-auto">
            <h2 className="text-2xl font-bold text-slate-900 mb-3">
              How your tier is decided
            </h2>
            <ol className="space-y-3 text-sm text-slate-700">
              <li>
                <strong>We read your Stripe live.</strong> WinbackFlow computes
                your MRR directly from your connected Stripe account &mdash;
                same math Stripe uses in your dashboard. No self-reporting.
              </li>
              <li>
                <strong>You see the breakdown before any charge.</strong> The
                activation page shows your MRR, the calculation, and the
                resulting tier. You click Subscribe at the displayed price or
                tell us &ldquo;this looks wrong&rdquo; first.
              </li>
              <li>
                <strong>We err in your favor.</strong> If your MRR sits within
                5% of a tier boundary, you stay in the lower tier. If your MRR
                later climbs, we&rsquo;ll prompt you to upgrade &mdash; never
                auto-charge.
              </li>
              <li>
                <strong>You can always verify.</strong> Your dashboard shows
                your MRR figure, your tier band, and your monthly fee
                side-by-side with last 30 days of recovered revenue. The math
                is always visible.
              </li>
            </ol>
          </div>

          <div className="mt-12 text-center">
            <TrackedCta
              href="/register"
              location="pricing"
              className="inline-flex items-center justify-center bg-[#0f172a] text-white rounded-full px-6 py-3 text-sm font-semibold hover:bg-[#1e293b] transition-colors"
            >
              Start free &mdash; pay nothing until first recovery
            </TrackedCta>
            <p className="mt-3 text-xs text-slate-500">
              Connect Stripe in 30 seconds. We&rsquo;ll only ask for a card
              after we&rsquo;ve recovered your first customer.
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

function TierCard({
  tier,
  band,
  price,
  perMonth,
  blurb,
  bullets,
  railClass,
  featured = false,
  isEnterprise = false,
}: {
  tier: string
  band: string
  price: string
  perMonth?: boolean
  blurb: string
  bullets: string[]
  railClass: string
  featured?: boolean
  isEnterprise?: boolean
}) {
  return (
    <div
      className={`rounded-2xl border ${
        featured ? 'border-blue-200 ring-1 ring-blue-100' : 'border-slate-100'
      } shadow-sm p-6 border-l-4 ${railClass} bg-white flex flex-col`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
        {tier}
      </p>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className="text-3xl font-bold text-slate-900 leading-none tabular-nums">
          {price}
        </span>
        {perMonth && <span className="text-sm text-slate-500">/ mo</span>}
      </div>
      <p className="mt-2 text-xs font-medium text-slate-500">{band}</p>
      <p className="mt-3 text-sm text-slate-600 leading-relaxed">{blurb}</p>

      <ul className="mt-5 pt-5 border-t border-slate-100 space-y-2.5 text-sm text-slate-700 flex-grow">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2.5">
            <Check
              className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5"
              strokeWidth={2.2}
            />
            <span>{b}</span>
          </li>
        ))}
      </ul>

      {isEnterprise && (
        <a
          href="mailto:sales@winbackflow.co?subject=Enterprise%20inquiry"
          className="mt-5 inline-flex items-center justify-center rounded-full bg-[#0f172a] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1e293b]"
        >
          Contact sales
        </a>
      )}
    </div>
  )
}

function TrustItem({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <Check
        className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5"
        aria-hidden
      />
      <span className="leading-relaxed">{children}</span>
    </div>
  )
}

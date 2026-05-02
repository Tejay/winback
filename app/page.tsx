import Link from 'next/link'
import { StickyNav } from '@/components/landing/sticky-nav'
import { FlowIllustration } from '@/components/landing/flow-illustration'
import { BundleCallout } from '@/components/landing/bundle-callout'
import { TwoPillarTeaser } from '@/components/landing/two-pillar-teaser'
import { LandingDashboardPreview } from '@/components/landing/landing-dashboard-preview'
import { PricingFormula } from '@/components/landing/pricing-formula'
import { Footer } from '@/components/landing/footer'

/**
 * Home page after the marketing reorg. Slim platform overview that sells
 * the bundle and points visitors at the two deep pages (/payment-recovery,
 * /win-back) for product detail.
 *
 * Structure:
 *   <StickyNav />                — site nav with feature links
 *   <Hero>                       — "Recover customers. Automatically."
 *   <BundleCallout />            — "Two flows. One platform." callout
 *   <TwoPillarTeaser />          — clickable cards → /payment-recovery + /win-back
 *   <PricingFormula />           — reframed "$99 + 1× MRR" formula + worked example
 *   <FooterCTA>                  — final connect-Stripe nudge
 *   <Footer />                   — site footer
 *
 * The previous home page (~541 lines) had the win-back deep dive inline.
 * That content moved to /win-back. The legacy 3-paragraph card-recovery
 * teaser became /payment-recovery.
 */
export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />

      {/* Hero — repositioned to platform-level */}
      <section className="bg-[#eef2fb] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6 flex flex-col items-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600 text-center">
            For subscription businesses losing customers every month
          </div>

          <h1 className="mt-6 text-center tracking-tight leading-[1.05] max-w-4xl">
            <span className="block text-4xl sm:text-6xl font-bold text-slate-900">
              Recover customers.
            </span>
            <span className="block text-4xl sm:text-6xl font-bold text-green-500">
              Automatically.
            </span>
          </h1>

          <p className="mt-6 text-base sm:text-lg text-slate-600 max-w-2xl text-center leading-relaxed">
            Payment failures and deliberate cancellations are the two ways subscription customers slip away. Winback is{' '}
            <span className="text-slate-900 font-medium">one platform that catches both</span>{' '}
            — always-on payment recovery, AI-drafted win-back emails. Two kinds of lost revenue, one Stripe connection.
          </p>

          <div className="flex flex-col items-center gap-2 mt-8">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-7 py-3 text-base font-medium hover:bg-[#1e293b]"
            >
              Start free — no card →
            </Link>
            <p className="text-sm text-slate-500">
              Connect Stripe · No card at signup.
            </p>
          </div>

          <FlowIllustration />
        </div>
      </section>

      <BundleCallout />
      <TwoPillarTeaser />
      <LandingDashboardPreview />
      <PricingFormula />

      {/* Footer CTA — kept as a final nudge */}
      <section className="bg-[#eef2fb] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <div className="text-xs font-semibold tracking-widest uppercase text-violet-600">
            Powered by AI tuned for retention
          </div>
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
            Connect Stripe. Stop the leak.
          </h2>

          <div className="mt-8">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              Start recovering today →
            </Link>
          </div>

          <p className="mt-6 text-sm text-slate-500">
            Free until we deliver your first save or win-back.
          </p>
        </div>
      </section>

      <Footer />
    </div>
  )
}

import Link from 'next/link'
import { StickyNav } from '@/components/landing/sticky-nav'
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
 *   <Hero>                       — "Stop losing customers to failed cards and cold cancellations."
 *   <TrustStrip>                 — Stripe Connect · no card · $0 until delivery
 *   <TwoPillarTeaser />          — differentiator header ("Read the actual
 *                                  reason. Respond specifically.") + colored-
 *                                  rail cards → /payment-recovery + /win-back.
 *                                  Carries the differentiator copy that used
 *                                  to live in a standalone BundleCallout.
 *   <LandingDashboardPreview />  — dashboard screenshot
 *   <PricingFormula />           — 3 cards: Platform / Recovery free / Win-back fee
 *   <FooterCTA>                  — guarantee-angle close (pay nothing until we deliver)
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

          {/* Headline frames the two failure modes explicitly. Inline
              green emphasis on "failed cards" + "cold cancellations"
              draws the eye to the specific threats; the rest of the
              statement stays calm black. Avoids over-promising
              "automatic" now that spec 80 made manual mode the new-
              merchant default for promo offers. */}
          <h1 className="mt-6 text-center tracking-tight leading-[1.05] max-w-4xl text-4xl sm:text-6xl font-bold text-slate-900">
            Stop losing customers to{' '}
            <span className="text-green-500 whitespace-nowrap">failed cards</span>
            {' '}and{' '}
            <span className="text-green-500 whitespace-nowrap">cold cancellations</span>.
          </h1>

          <p className="mt-6 text-base sm:text-lg text-slate-600 max-w-2xl text-center leading-relaxed">
            Payment failures and deliberate cancellations are the two
            ways subscription customers slip away. WinbackFlow is{' '}
            <span className="text-slate-900 font-medium">one platform that catches both</span>{' '}
            &mdash; always-on payment recovery for failed cards, and
            cancellation monitoring that emails the right subscribers
            when you ship the change that matches. Two kinds of lost
            revenue, one Stripe connection.
          </p>

          <div className="flex flex-col items-center mt-8">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-7 py-3 text-base font-medium hover:bg-[#1e293b]"
            >
              Start free — no card →
            </Link>
          </div>

          {/* FlowIllustration removed from home: the two-pillar teaser
              below already shows both flows (Payment recovery + Cancellation
              winbacks) in full with proof boxes, so the hero illustration
              was redundant AND told only half the story. The illustration
              lives on /win-back hero where it's the right surface for that
              single-flow story. */}
        </div>
      </section>

      {/* Trust strip — thin band between hero and the two-pillar teaser.
          What's true at the platform level: one Stripe connection, no
          card collected up front, $0 billed until WinbackFlow has
          delivered an actual recovery. The tier-based fee only kicks
          in once value has been proven. */}
      <section className="bg-white border-b border-slate-100 py-4">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-center gap-2 text-xs text-slate-500 flex-wrap">
          <span>
            Built on <strong className="text-slate-700">Stripe Connect Standard</strong>
          </span>
          <span className="text-slate-300">·</span>
          <span>No card at signup</span>
          <span className="text-slate-300">·</span>
          <span>$0 until we recover your first customer</span>
        </div>
      </section>

      <TwoPillarTeaser />
      <LandingDashboardPreview />
      <PricingFormula />

      {/* Footer CTA — guarantee angle. The Hero asks for the click on
          the promise of recovery; this section closes by removing risk.
          "Start free" reflects the real semantic: billing only kicks in
          on first delivered save, and even then the customer reviews
          and confirms a tier-derived price BEFORE any charge. */}
      <section className="bg-[#eef2fb] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <p className="text-xs font-semibold tracking-widest uppercase text-violet-600">
            No risk, no commitment
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-slate-900">
            Pay nothing until we save you something.
          </h2>
          <p className="mt-4 text-sm text-slate-600 max-w-xl mx-auto">
            $0 until WinbackFlow delivers a payment recovery or
            cancellation winback. After that, one flat monthly fee
            priced by your own MRR &mdash; you see the math and confirm
            the tier before any charge. Cancel anytime in one click.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              Start free &mdash; no card →
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

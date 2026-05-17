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
 *   <TrustStrip>                 — Stripe Connect · no card · $0 until delivery
 *   <BundleCallout />            — differentiator: "Read the actual reason..."
 *   <TwoPillarTeaser />          — colored-rail cards → /payment-recovery + /win-back
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
            &mdash; always-on payment recovery for failed cards, AI-drafted win-back emails for cancelled customers. Two kinds of lost revenue, one Stripe connection.
          </p>

          <div className="flex flex-col items-center mt-8">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-7 py-3 text-base font-medium hover:bg-[#1e293b]"
            >
              Start free — no card →
            </Link>
          </div>

          <FlowIllustration />
        </div>
      </section>

      {/* Trust strip — thin band between hero and bundle callout. The
          claim that used to live below the Hero CTA ("Connect Stripe ·
          No card at signup") is folded in here.

          Copy precision: we do NOT have a general 14-day money-back
          guarantee or a 14-day free trial. The only refund is on the
          win-back fee, and only if the won-back customer re-cancels
          within 14 days. So the third item promises what's actually
          true at the platform level: you pay $0 until we deliver
          something. */}
      <section className="bg-white border-b border-slate-100 py-4">
        <div className="max-w-5xl mx-auto px-6 flex items-center justify-center gap-2 text-xs text-slate-500 flex-wrap">
          <span>
            Built on <strong className="text-slate-700">Stripe Connect Standard</strong>
          </span>
          <span className="text-slate-300">·</span>
          <span>No card required</span>
          <span className="text-slate-300">·</span>
          <span>$0 until we deliver a save</span>
        </div>
      </section>

      <BundleCallout />
      <TwoPillarTeaser />
      <LandingDashboardPreview />
      <PricingFormula />

      {/* Footer CTA — guarantee angle, not a duplicate of the Hero CTA.
          The Hero asks for the click on the promise of recovery; this
          section closes by removing risk.

          Copy precision: we do NOT have a general 14-day money-back
          guarantee or a 14-day free trial. The only refund is on the
          win-back fee, and only if the won-back customer re-cancels
          within 14 days. CTA text reflects that — "Start free" (true:
          billing starts on first delivered save) not "Try free for
          14 days" (false: implies time-limited trial). */}
      <section className="bg-[#eef2fb] py-20 sm:py-24">
        <div className="max-w-5xl mx-auto px-6 text-center">
          <p className="text-xs font-semibold tracking-widest uppercase text-violet-600">
            No risk, no commitment
          </p>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-slate-900">
            Pay nothing until we save you something.
          </h2>
          <p className="mt-4 text-sm text-slate-600 max-w-xl mx-auto">
            You pay $0 until we deliver a payment recovery or win-back.
            Win-back fees are refunded if the customer re-cancels within
            14 days. Cancel anytime in one click.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/register"
              className="bg-[#0f172a] text-white rounded-full px-6 py-2.5 text-sm font-medium hover:bg-[#1e293b]"
            >
              Start free — no card →
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  )
}

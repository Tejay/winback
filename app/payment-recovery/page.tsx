import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { Hero } from '@/components/payment-recovery/hero'
import { Timeline } from '@/components/payment-recovery/timeline'
import { CheckoutMockup } from '@/components/payment-recovery/checkout-mockup'
import { EmailComparison } from '@/components/payment-recovery/email-comparison'
import { Cta } from '@/components/payment-recovery/cta'
import { WelcomeBack } from '@/components/payment-recovery/welcome-back'
import { PaymentRecoveryPreviewStrip } from '@/components/demo/dashboard-preview-strip'

export default function PaymentRecoveryPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />

      {/* Reading order — numbered five-step story so the visitor follows
          one continuous narrative top-to-bottom:
            Hero               — stake (5-7% MRR loss) + 3 pillar claims
            01 How it works    (Timeline)        — the timing: where we sit
                                                    in Stripe's retry window
            02 The email       (EmailComparison) — what the customer receives
            03 Your dashboard                    — what the merchant sees
            04 When they click (CheckoutMockup)  — the update-card landing page
            05 Welcome back    (WelcomeBack)     — the celebratory page that
                                                    closes the loop
            Cta                — de-risked ask with pricing + no-card
      */}
      <Hero />
      <Timeline />
      <EmailComparison />

      {/* Dashboard — what the merchant sees. Cropped to pipeline + KPIs
          only; full demo is one click away. */}
      <section className="py-20 sm:py-24 px-6 bg-white border-t border-slate-100">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">03 · Your dashboard</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight text-slate-900 max-w-3xl mx-auto">
              Every failed charge, every retry, every recovery &mdash;
              tracked in one place.
            </h2>
            <p className="mt-4 text-sm text-slate-600 max-w-2xl mx-auto">
              A snapshot below. Click &ldquo;Explore the dashboard&rdquo;
              for the full preview with the per-row retry detail.
            </p>
          </div>
          <PaymentRecoveryPreviewStrip />
        </div>
      </section>

      <CheckoutMockup />
      <WelcomeBack />
      <Cta />
      <Footer />
    </div>
  )
}

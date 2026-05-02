import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { Hero } from '@/components/payment-recovery/hero'
import { Pillars } from '@/components/payment-recovery/pillars'
import { Timeline } from '@/components/payment-recovery/timeline'
import { WhyNotStripe } from '@/components/payment-recovery/why-not-stripe'
import { CheckoutMockup } from '@/components/payment-recovery/checkout-mockup'
import { EmailComparison } from '@/components/payment-recovery/email-comparison'
import { Cta } from '@/components/payment-recovery/cta'
import { PaymentRecoveryPreviewStrip } from '@/components/demo/dashboard-preview-strip'

export default function PaymentRecoveryPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />

      {/* Reading order:
          Hero          — set the stake (5-7% MRR loss)
          Pillars       — three claims as scan anchors (no body text)
          Timeline      — proves "we lead Stripe's retries"
          WhyNotStripe  — head-on objection handling, before the heavy proof
          CheckoutMockup — proves "Apple Pay / Google Pay / Link" (the page)
          EmailComparison — proves "decline-aware copy" (the email)
          Dashboard     — proves it's tracked + measurable
          Cta           — de-risked ask with pricing/time/no-card
      */}
      <Hero />
      <Pillars />
      <Timeline />
      <WhyNotStripe />
      <CheckoutMockup />
      <EmailComparison />

      {/* Dashboard preview — sits last before the CTA so the prospect
          ends on the "ongoing tracking" surface that becomes theirs once
          they connect Stripe. Cropped to pipeline + KPIs only; full demo
          is one click away. */}
      <section className="py-14 sm:py-16 px-6 bg-white">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-8">
            <div className="text-xs font-semibold tracking-widest uppercase text-emerald-700">
              Your payment recovery dashboard
            </div>
            <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight max-w-3xl mx-auto">
              Every failed charge, every retry, every recovery &mdash;
              tracked in one place.
            </h2>
            <p className="mt-3 text-sm text-slate-500 max-w-xl mx-auto">
              A snapshot below. Click &ldquo;See live demo&rdquo; for the full
              dashboard with the per-row retry detail.
            </p>
          </div>
          <PaymentRecoveryPreviewStrip />
        </div>
      </section>

      <Cta />
      <Footer />
    </div>
  )
}

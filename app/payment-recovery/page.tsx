import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { Hero } from '@/components/payment-recovery/hero'
import { Pillars } from '@/components/payment-recovery/pillars'
import { Timeline } from '@/components/payment-recovery/timeline'
import { EmailComparison } from '@/components/payment-recovery/email-comparison'
import { CheckoutMockup } from '@/components/payment-recovery/checkout-mockup'
import { Cta } from '@/components/payment-recovery/cta'

export default function PaymentRecoveryPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />
      <Hero />
      <Pillars />
      <Timeline />
      <EmailComparison />
      <CheckoutMockup />
      <Cta />
      <Footer />
    </div>
  )
}

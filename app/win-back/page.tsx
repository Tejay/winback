import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { Hero } from '@/components/win-back/hero'
import { HowItWorks } from '@/components/win-back/how-it-works'
import { Cta } from '@/components/win-back/cta'

export default function WinBackPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />
      <Hero />
      <HowItWorks />
      <Cta />
      <Footer />
    </div>
  )
}

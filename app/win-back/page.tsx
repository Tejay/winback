import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { Hero } from '@/components/win-back/hero'
import { Pillars } from '@/components/win-back/pillars'
import { HowItWorks } from '@/components/win-back/how-it-works'
import { Cta } from '@/components/win-back/cta'

export default function WinBackPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />
      <Hero />
      <Pillars />
      <HowItWorks />
      <Cta />
      <Footer />
    </div>
  )
}

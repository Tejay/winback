import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { Hero } from '@/components/win-back/hero'
import { HowItWorks } from '@/components/win-back/how-it-works'
import { Cta } from '@/components/win-back/cta'
import { WinBackPreviewStrip } from '@/components/demo/dashboard-preview-strip'

export default function WinBackPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />
      <Hero />
      <HowItWorks />

      {/* Dashboard preview — sits after HowItWorks (now you've seen the
          flow) and before Cta (now act on it). Cropped to pipeline +
          KPIs only; full demo is one click away. */}
      <section className="py-14 sm:py-16 px-6 bg-white">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-8">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              Your win-back dashboard
            </div>
            <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight max-w-3xl mx-auto">
              Every cancellation, classified, scored, and queued for action.
            </h2>
            <p className="mt-3 text-sm text-slate-500 max-w-xl mx-auto">
              A snapshot below. Click &ldquo;See live demo&rdquo; for the full
              dashboard with the per-subscriber drawer.
            </p>
          </div>
          <WinBackPreviewStrip />
        </div>
      </section>

      <Cta />
      <Footer />
    </div>
  )
}

import { StickyNav } from '@/components/landing/sticky-nav'
import { Footer } from '@/components/landing/footer'
import { Hero } from '@/components/win-back/hero'
import { HowItWorks } from '@/components/win-back/how-it-works'
import { YourPart } from '@/components/win-back/your-part'
import { Cta } from '@/components/win-back/cta'
import { WinBackPreviewStrip } from '@/components/demo/dashboard-preview-strip'

/**
 * /win-back reading order — a coherent three-beat story:
 *   Hero          — the promise (cancellations are recoverable)
 *   How it works  — the system (Detect / Decide / Act, colored rails)
 *   Your part     — the merchant's one action (address a cancellation
 *                   reason; we email the customers who cited it).
 *                   Sits on the grey f5f5f5 ground so the page rhythm is
 *                   blue → white → grey → white → blue.
 *   Dashboard     — what you see (tracking outcomes)
 *   Cta           — start
 *
 * Section eyebrow triad: "How it works" → "Your part" → "Dashboard ·
 * What you see" — explicitly names where the merchant is in the
 * story at each section.
 */
export default function WinBackPage() {
  return (
    <div className="min-h-screen">
      <StickyNav />
      <Hero />
      <HowItWorks />
      <YourPart />

      {/* Dashboard preview — what you see. Section spacing + eyebrow
          aligned with the other sections for visual consistency. */}
      <section className="py-20 sm:py-24 px-6 bg-white border-t border-slate-100">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-8 max-w-3xl mx-auto">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              Dashboard · What you see
            </div>
            <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
              Every cancellation, classified, scored, and queued for action.
            </h2>
            <p className="mt-4 text-sm sm:text-base text-slate-600 leading-relaxed">
              A snapshot below. Click &ldquo;Explore the dashboard&rdquo;
              for the full preview with the per-subscriber drawer.
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

import Image from 'next/image'
import { RevealOnScroll } from '@/components/landing/reveal-on-scroll'

/**
 * Dashboard proof block — common to both flows (payment recovery + win-back),
 * so lives on the home page where both stories converge. Shows the unified
 * dashboard that tracks every recovery regardless of source.
 */
export function DashboardProof() {
  return (
    <section className="bg-[#f5f5f5] py-20 sm:py-24">
      <div className="max-w-5xl mx-auto px-6">
        <RevealOnScroll>
          <div className="text-center mb-10">
            <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
              Your dashboard
            </div>
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mt-3">
              Every recovery, tracked.
            </h2>
            <p className="text-base sm:text-lg text-slate-500 mt-4 max-w-2xl mx-auto">
              See who cancelled, why they left, what Winback sent, and who came back — all in one view. Payment failures and deliberate cancellations show up side-by-side.
            </p>
          </div>
          <div className="rounded-2xl overflow-hidden shadow-lg border border-slate-200/60">
            <Image
              src="/demo-dashboard.png"
              alt="Winback dashboard showing recovered subscribers, recovery rate, and MRR recovered"
              width={1200}
              height={750}
              className="w-full h-auto"
            />
          </div>
        </RevealOnScroll>
      </div>
    </section>
  )
}

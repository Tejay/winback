/**
 * Landing-page replacement for the old static <DashboardProof>. Renders
 * both cohort preview strips (win-back + payment recovery) stacked, with
 * a section header and a hint line pointing prospects to either full
 * dashboard preview.
 *
 * Stacks rather than splits side-by-side because each preview strip
 * already has 4 KPI cards in its own grid — putting two of them
 * side-by-side would push the cards down to 2 columns each, losing the
 * sparkline trends to wrap and breaking the visual rhythm. Stacked
 * keeps each preview at full width and full visual weight.
 */

import {
  WinBackPreviewStrip,
  PaymentRecoveryPreviewStrip,
} from '@/components/demo/dashboard-preview-strip'

export function LandingDashboardPreview() {
  return (
    <section className="py-16 sm:py-20 px-6">
      <div className="max-w-5xl mx-auto">
        <div className="text-center mb-10">
          <div className="text-xs font-semibold tracking-widest uppercase text-blue-600">
            Built for triage, not just metrics
          </div>
          <h2 className="mt-3 text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight">
            See where every dollar is &mdash; recovered, in flight, or lost.
          </h2>
          <p className="mt-3 text-sm sm:text-base text-slate-600 max-w-xl mx-auto">
            Two dashboards, one platform. Click either to explore the
            full preview with realistic data.
          </p>
        </div>

        <div className="space-y-6">
          <WinBackPreviewStrip />
          <PaymentRecoveryPreviewStrip />
        </div>
      </div>
    </section>
  )
}

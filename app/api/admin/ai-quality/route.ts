import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  // Spec 26 (legacy — removed in Phase D)
  handoffVolumeTrend,
  autoLostTrend,
  tierDistribution,
  handoffAudit,
  autoLostAudit,
  // Spec 78 Phase A
  weekVsBaseline,
  cancellationCategoryMix,
  lowConfidenceClassifications,
  // Spec 78 Phase B
  calibrationCohort,
  reengagementMatchRate,
} from '@/lib/admin/ai-quality-queries'

/**
 * GET /api/admin/ai-quality
 *
 * Spec 78 redesign. Returns the full `/admin/ai-quality` payload in
 * parallel. Phase A adds drift detection, cancellation-category mix,
 * and low-confidence classification audit. Phases B (calibration +
 * match rate) and C (smart-ranked audits) extend this payload; legacy
 * Spec 26 fields stay until Phase D removes them.
 */
export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const [
    handoffs,
    autoLost,
    tier,
    recentHandoffs,
    recentAutoLost,
    drift,
    categoryMix,
    lowConfidence,
    calibration,
    matchRate,
  ] = await Promise.all([
    handoffVolumeTrend(30),
    autoLostTrend(30),
    tierDistribution(30),
    handoffAudit(50),
    autoLostAudit(50),
    weekVsBaseline(),
    cancellationCategoryMix(),
    lowConfidenceClassifications(25),
    calibrationCohort(90, 30),
    reengagementMatchRate(90),
  ])
  return NextResponse.json({
    // Legacy — Phase D removes these
    handoffs,
    autoLost,
    tier,
    recentHandoffs,
    recentAutoLost,
    // Spec 78 Phase A
    drift,
    categoryMix,
    lowConfidence,
    // Spec 78 Phase B
    calibration,
    matchRate,
  })
}

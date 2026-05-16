import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  // Spec 78 Phase A
  weekVsBaseline,
  cancellationCategoryMix,
  lowConfidenceClassifications,
  // Spec 78 Phase B
  calibrationCohort,
  reengagementMatchRate,
  // Spec 78 Phase C
  rankedAutoLostAudit,
  rankedHandoffAudit,
  handoffAuditSummary,
} from '@/lib/admin/ai-quality-queries'

/**
 * GET /api/admin/ai-quality
 *
 * Spec 78 redesign. Seven blocks served from a single parallel
 * Promise.all so the page loads in one round-trip:
 *
 *   1. Calibration — predictions joined to outcomes on a 30-90d cohort
 *   2. Drift detection — last 7d vs prior 23d on 6 quality metrics
 *   3. Cancellation category mix — 30d distribution + 7d shift
 *   4. Smart-ranked auto-lost audit — top 15 by interest_score
 *   5. Smart-ranked handoff audit — top 15 + resolution column + 30d summary
 *   6. Low-confidence classifications — last 25 with confidence < 0.4
 *   7. Re-engagement match rate — 90d eligible / emailed / expired / pending
 *
 * All read-only against `DATABASE_URL_READONLY`. No schema changes.
 */
export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const [
    drift,
    categoryMix,
    lowConfidence,
    calibration,
    matchRate,
    rankedAutoLost,
    rankedHandoffs,
    handoffSummary,
  ] = await Promise.all([
    weekVsBaseline(),
    cancellationCategoryMix(),
    lowConfidenceClassifications(25),
    calibrationCohort(90, 30),
    reengagementMatchRate(90),
    rankedAutoLostAudit(15),
    rankedHandoffAudit(15),
    handoffAuditSummary(30),
  ])
  return NextResponse.json({
    drift,
    categoryMix,
    lowConfidence,
    calibration,
    matchRate,
    rankedAutoLost,
    rankedHandoffs,
    handoffSummary,
  })
}

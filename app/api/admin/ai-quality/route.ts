import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  weekVsBaseline,
  cancellationCategoryMix,
  lowConfidenceClassifications,
  calibrationCohort,
  reengagementMatchRate,
  rankedSuppressionAudit,
  emailPerformance,
} from '@/lib/admin/ai-quality-queries'

/**
 * GET /api/admin/ai-quality
 *
 * Rethought around what the classifier actually does today — classify +
 * write the email copy + label for re-engagement. Handoff and auto-lost
 * are gone (classifier.ts: "there is no automatic handoff anymore"), so
 * those blocks were removed; tier-4 "suppress" is the AI's only don't-
 * email decision now.
 *
 * Sections:
 *   - Health  : drift (did something change?)
 *   - Trust   : calibration (does likelihood predict recovery?) +
 *               suppression reversal (did we silence recoverable subs?)
 *   - Emails  : reply rate by type (the AI writes the copy) + flagged queue
 *   - Reasons : category mix + low-confidence audit + re-engagement match
 *
 * A rolled-up `verdict` answers "is the AI healthy?" in one glance.
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
    suppressionAudit,
    emails,
  ] = await Promise.all([
    weekVsBaseline(),
    cancellationCategoryMix(),
    lowConfidenceClassifications(25),
    calibrationCohort(90, 30),
    reengagementMatchRate(90),
    rankedSuppressionAudit(15),
    emailPerformance(30),
  ])

  // Roll up a plain "is the AI healthy?" verdict.
  const reasons: string[] = []
  for (const m of drift.metrics.filter((m) => m.flagged)) reasons.push(`${m.label} drifted`)

  const high = calibration.byLikelihood.find((r) => r.likelihood === 'high')
  const low  = calibration.byLikelihood.find((r) => r.likelihood === 'low')
  // Only judge calibration when there's enough settled data to be meaningful.
  const calibrationMeaningful = (high?.n ?? 0) >= 10 && (low?.n ?? 0) >= 10
  if (calibrationMeaningful && (high?.recoveryRatePct ?? 0) <= (low?.recoveryRatePct ?? 0)) {
    reasons.push('high-likelihood subscribers are not recovering more than low')
  }

  const sup = calibration.suppressionReversal
  const supReversalPct = sup.suppressed > 0 ? (sup.recovered / sup.suppressed) * 100 : 0
  if (sup.suppressed >= 10 && supReversalPct > 10) {
    reasons.push(`${sup.recovered}/${sup.suppressed} suppressed subscribers recovered anyway`)
  }

  const verdict = {
    status: reasons.length === 0 ? 'healthy' : 'attention',
    reasons,
  }

  return NextResponse.json({
    verdict,
    drift,
    categoryMix,
    lowConfidence,
    calibration,
    matchRate,
    suppressionAudit,
    emails,
  })
}

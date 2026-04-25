import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  handoffVolumeTrend,
  autoLostTrend,
  recoveryLikelihoodHistogram,
  tierDistribution,
  handoffAudit,
  autoLostAudit,
} from '@/lib/admin/ai-quality-queries'

/**
 * GET /api/admin/ai-quality
 *
 * Returns the full /admin/ai-quality payload in parallel:
 *   - 30d handoff trend + 30d auto-lost trend (paired so the bad failure
 *     mode "handoffs went down AND auto-lost went up" is visible)
 *   - 30d recovery-likelihood histogram (calibration)
 *   - 30d tier distribution (catches Tier-4 surge from a prompt regression)
 *   - 50 most recent handoff reasonings (audit sample)
 *   - 50 most recent auto-lost events (cases that should have escalated)
 */
export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const [
    handoffs,
    autoLost,
    likelihood,
    tier,
    recentHandoffs,
    recentAutoLost,
  ] = await Promise.all([
    handoffVolumeTrend(30),
    autoLostTrend(30),
    recoveryLikelihoodHistogram(30),
    tierDistribution(30),
    handoffAudit(50),
    autoLostAudit(50),
  ])
  return NextResponse.json({
    handoffs,
    autoLost,
    likelihood,
    tier,
    recentHandoffs,
    recentAutoLost,
  })
}

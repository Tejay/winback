import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { buildOverviewRollup } from '@/lib/admin/rollups'
import { getCronHealth } from '@/lib/admin/cron-queries'
import { buildStuckCohorts } from '@/lib/admin/stuck-cohorts'
import { countDeadLetteredRows } from '@/src/winback/lib/classifier-tick'

/**
 * GET /api/admin/overview
 *
 * Full payload for the Now page. Polled every 30s by the admin client.
 *
 * Composed in parallel:
 *  - rollup        (counters, sparklines, growth, paywall, billing,
 *                   red-lights, errorsTail, recentAdminActivity)
 *  - cronHealth    (per-cron status incl. slow-detection)
 *  - stuckCohorts  (6 point-in-time worklist tiles)
 *  - deadLetteredClassify (kept for back-compat; same value also
 *                          appears in stuckCohorts.classifierDeadLetter)
 */
export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  try {
    const [rollup, cronHealth, stuckCohorts, deadLetteredClassify] = await Promise.all([
      buildOverviewRollup(),
      getCronHealth(),
      buildStuckCohorts(),
      countDeadLetteredRows(),
    ])
    return NextResponse.json({
      ...rollup,
      cronHealth,
      stuckCohorts,
      deadLetteredClassify,
    })
  } catch (err) {
    console.error('[admin/overview] failed', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build overview' },
      { status: 500 },
    )
  }
}

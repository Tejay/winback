import { NextResponse } from 'next/server'
import { sql, and, eq, gte } from 'drizzle-orm'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { wbEvents } from '@/lib/schema'
import { buildOverviewRollup } from '@/lib/admin/rollups'
import { getCronHealth } from '@/lib/admin/cron-queries'
import { buildStuckCohorts } from '@/lib/admin/stuck-cohorts'
import { countDeadLetteredRows } from '@/src/winback/lib/classifier-tick'
import { getSendingMode } from '@/src/winback/lib/sending-mode'

async function countSuppressedToday(): Promise<number> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0)
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, 'email_suppressed'), gte(wbEvents.createdAt, start)))
  return row?.n ?? 0
}

/**
 * GET /api/admin/overview
 *
 * Full payload for the Now page. Polled every 30s by the admin client.
 *
 * Composed in parallel:
 *  - rollup        (counters, sparklines, growth, paywall, billing,
 *                   red-lights, errorsTail, recentAdminActivity)
 *  - cronHealth    (per-cron staleness: ok/stale/failed/never-run)
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
    const [rollup, cronHealth, stuckCohorts, deadLetteredClassify, sendingMode, suppressedToday] = await Promise.all([
      buildOverviewRollup(),
      getCronHealth(),
      buildStuckCohorts(),
      countDeadLetteredRows(),
      getSendingMode(),
      countSuppressedToday(),
    ])
    return NextResponse.json({
      ...rollup,
      cronHealth,
      stuckCohorts,
      deadLetteredClassify,
      sending: { mode: sendingMode, suppressedToday },
    })
  } catch (err) {
    console.error('[admin/overview] failed', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build overview' },
      { status: 500 },
    )
  }
}

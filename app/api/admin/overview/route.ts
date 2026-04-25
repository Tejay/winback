import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { buildOverviewRollup } from '@/lib/admin/rollups'

/**
 * GET /api/admin/overview
 *
 * Returns the full overview rollup (counters + sparklines + totals + red
 * lights). Polled every 30s by /admin client-side.
 */
export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  try {
    const rollup = await buildOverviewRollup()
    return NextResponse.json(rollup)
  } catch (err) {
    console.error('[admin/overview] failed', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build overview' },
      { status: 500 },
    )
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { buildInsights, type InsightsWindow } from '@/lib/admin/insights-queries'

/**
 * GET /api/admin/insights?window=7d|30d|90d
 *
 * Business (Insights) page data. Load-once (not polled) — a review
 * surface, so it's fine to compute the full set on each request.
 */
const VALID_WINDOWS: InsightsWindow[] = ['7d', '30d', '90d']

export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const raw = req.nextUrl.searchParams.get('window') ?? '30d'
  const window: InsightsWindow = (VALID_WINDOWS as string[]).includes(raw) ? (raw as InsightsWindow) : '30d'

  try {
    const data = await buildInsights(window)
    return NextResponse.json(data)
  } catch (err) {
    console.error('[admin/insights] failed', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build insights' },
      { status: 500 },
    )
  }
}

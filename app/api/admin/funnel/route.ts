import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { buildAcquisitionFunnel, type FunnelWindow } from '@/lib/admin/funnel-queries'

/**
 * GET /api/admin/funnel?window=7d|30d|90d|all
 *
 * Merchant acquisition/activation funnel for /admin/insights/funnel.
 * Load-once review surface (not polled), gated to admins.
 */
const VALID_WINDOWS: FunnelWindow[] = ['7d', '30d', '90d', 'all']

export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const raw = req.nextUrl.searchParams.get('window') ?? '30d'
  const window: FunnelWindow = (VALID_WINDOWS as string[]).includes(raw) ? (raw as FunnelWindow) : '30d'

  try {
    const data = await buildAcquisitionFunnel(window)
    return NextResponse.json(data)
  } catch (err) {
    console.error('[admin/funnel] failed', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to build funnel' },
      { status: 500 },
    )
  }
}

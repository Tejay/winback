import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  mrrRecoveredWeeklyTrend,
  detectStripeMode,
} from '@/lib/admin/billing-queries'

/**
 * GET /admin/billing payload — slimmed by the billing rewrite. With
 * perf fees removed, there are no per-recovery obligations or refundable
 * charges to surface. What remains: the weekly MRR-recovered trend (still
 * a useful operational signal). The admin UI for queued / charged perf
 * fees has been retired in the same change set.
 */
export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const mrrTrend = await mrrRecoveredWeeklyTrend(13)
  return NextResponse.json({
    mrrTrend,
    stripeMode: detectStripeMode(),
  })
}

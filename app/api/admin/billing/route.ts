import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  currentPeriodBreakdown,
  failedRuns,
  outstandingObligations,
  mrrRecoveredWeeklyTrend,
} from '@/lib/admin/billing-queries'

/**
 * GET /admin/billing payload — current month status, failed invoices (90d),
 * outstanding obligations, MRR-recovered trend (13 weeks).
 */
export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const [breakdown, failed, outstanding, mrrTrend] = await Promise.all([
    currentPeriodBreakdown(),
    failedRuns(90),
    outstandingObligations(),
    mrrRecoveredWeeklyTrend(13),
  ])
  return NextResponse.json({ breakdown, failed, outstanding, mrrTrend })
}

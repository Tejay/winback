import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import {
  outstandingObligations,
  mrrRecoveredWeeklyTrend,
  chargedPerfFees,
  detectStripeMode,
} from '@/lib/admin/billing-queries'

/**
 * GET /admin/billing payload — Phase C slim. Stripe Subscriptions own
 * monthly billing now, so we only surface what's worth eyeballing in-app:
 * queued win-back fees and the weekly MRR-recovered trend.
 */
export async function GET() {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const [outstanding, mrrTrend, charged] = await Promise.all([
    outstandingObligations(),
    mrrRecoveredWeeklyTrend(13),
    chargedPerfFees(200),
  ])
  return NextResponse.json({
    outstanding,
    mrrTrend,
    charged,
    stripeMode: detectStripeMode(),
  })
}

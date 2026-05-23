import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, recoveries } from '@/lib/schema'
import { eq, and, gte, inArray } from 'drizzle-orm'
import { prepareActivation } from '@/src/winback/lib/activation'
import { tierBandLabel, tierLabel } from '@/src/winback/lib/tiers'
import { ROI_DISPLAY_WINDOW_DAYS } from '@/src/winback/lib/billing-config'

/**
 * GET /api/billing/activation-preview
 *
 * Powers the activation confirmation page (`/billing/activate`). Runs
 * prepareActivation to compute the customer's live MRR, derive the
 * recommended tier, and return everything the page needs to render the
 * transparency block:
 *   - MRR figure + per-currency + status counts
 *   - Recommended tier + band label + price
 *   - Trailing-30d recovered revenue (strong + weak attribution)
 *   - Stripe's reported MRR if available (extra dispute armor)
 *
 * Returns:
 *   - 200 { state: 'awaiting_confirmation', ...preview }     — normal path
 *   - 200 { state: 'enterprise_handoff', mrrUsdMinor, ... }  — contact sales
 *   - 200 { state: 'no_op' }                                  — no delivery yet
 *   - 200 { state: 'pilot', pilotUntil }                      — pilot active
 *
 * Idempotent — the page can poll without side effects beyond a snapshot
 * row write. prepareActivation only marks activatedAt on the first call.
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const prep = await prepareActivation(customer.id)

  // Compute trailing-30d recovered revenue regardless of state — useful for
  // the ROI display even in pilot/no_op cases.
  const since = new Date(Date.now() - ROI_DISPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const recoveryRows = await db
    .select({ mrrCents: recoveries.planMrrCents })
    .from(recoveries)
    .where(
      and(
        eq(recoveries.customerId, customer.id),
        gte(recoveries.recoveredAt, since),
        inArray(recoveries.attributionType, ['strong', 'weak']),
      ),
    )
  const recoveredTrailing30d = recoveryRows.reduce(
    (sum, r) => sum + (r.mrrCents ?? 0),
    0,
  )

  if (prep.state === 'awaiting_confirmation') {
    return NextResponse.json({
      state: 'awaiting_confirmation',
      tier: prep.tier,
      tierLabel: prep.tier === 'custom' ? prep.tierLabel : tierLabel(prep.tier),
      tierBandLabel: prep.tier === 'custom' ? null : tierBandLabel(prep.tier),
      priceUsdMinor: prep.priceUsdMinor,
      mrrUsdMinor: prep.mrrUsdMinor,
      perCurrency: prep.perCurrency,
      breakdown: prep.mrrBreakdown,
      trailing30dRecoveredUsdMinor: recoveredTrailing30d,
      roiRatio:
        prep.priceUsdMinor > 0
          ? recoveredTrailing30d / prep.priceUsdMinor
          : 0,
    })
  }

  if (prep.state === 'enterprise_handoff') {
    return NextResponse.json({
      state: 'enterprise_handoff',
      mrrUsdMinor: prep.mrrUsdMinor,
      breakdown: prep.mrrBreakdown,
      trailing30dRecoveredUsdMinor: recoveredTrailing30d,
    })
  }

  if (prep.state === 'pilot') {
    return NextResponse.json({
      state: 'pilot',
      pilotUntil: prep.pilotUntil?.toISOString() ?? null,
      trailing30dRecoveredUsdMinor: recoveredTrailing30d,
    })
  }

  return NextResponse.json({
    state: 'no_op',
    trailing30dRecoveredUsdMinor: recoveredTrailing30d,
  })
}

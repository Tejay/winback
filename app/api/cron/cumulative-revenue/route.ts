import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { customers, recoveries, churnedSubscribers } from '@/lib/schema'
import {
  computeCumulativeRevenueSavedCents,
  type RecoveryForRevenue,
  type SubscriberLifecycle,
} from '@/src/winback/lib/revenue'

export const maxDuration = 60

/**
 * Spec 41 — Daily cron that recomputes cumulative_revenue_saved_cents
 * for every customer.
 *
 * Reads `wb_recoveries` + `wb_churned_subscribers` per customer, calls
 * the pure helper, writes the result to `wb_customers`. Idempotent —
 * re-running produces the same value (modulo time passing).
 *
 * Schedule: daily at 03:00 UTC via vercel.json.
 *
 * Auth: Bearer ${CRON_SECRET}, identical to other cron routes.
 *
 * `?dryRun=1` returns the values it would write without writing them.
 * Useful for the first prod run to spot-check before letting it touch
 * the table.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryRun = req.nextUrl.searchParams.get('dryRun') === '1'
  const asOf = new Date()

  const allCustomers = await db
    .select({ id: customers.id })
    .from(customers)

  const results: Array<{ customerId: string; cents: number }> = []

  for (const c of allCustomers) {
    const rec = await db
      .select({
        subscriptionId: churnedSubscribers.stripeSubscriptionId,
        mrrCents: recoveries.planMrrCents,
        recoveredAt: recoveries.recoveredAt,
      })
      .from(recoveries)
      .innerJoin(churnedSubscribers, eq(churnedSubscribers.id, recoveries.subscriberId))
      .where(eq(recoveries.customerId, c.id))

    // Latest cancelledAt per subscriptionId — represents a re-churn event
    // that may have ended a recovered segment. The pure helper compares
    // against each recovery's recoveredAt and ignores older events.
    const churns = await db
      .select({
        subscriptionId: churnedSubscribers.stripeSubscriptionId,
        cancelledAt: churnedSubscribers.cancelledAt,
      })
      .from(churnedSubscribers)
      .where(eq(churnedSubscribers.customerId, c.id))

    const lifecycles = new Map<string, SubscriberLifecycle>()
    for (const ch of churns) {
      if (!ch.subscriptionId || !ch.cancelledAt) continue
      const existing = lifecycles.get(ch.subscriptionId)
      if (!existing || (existing.reChurnedAt && ch.cancelledAt > existing.reChurnedAt)) {
        lifecycles.set(ch.subscriptionId, { reChurnedAt: ch.cancelledAt })
      }
    }

    const recoveryRows: RecoveryForRevenue[] = rec
      .filter((r) => r.recoveredAt !== null)
      .map((r) => ({
        subscriptionId: r.subscriptionId,
        mrrCents: r.mrrCents,
        recoveredAt: r.recoveredAt as Date,
      }))

    const cents = computeCumulativeRevenueSavedCents(recoveryRows, lifecycles, asOf)
    results.push({ customerId: c.id, cents })

    if (!dryRun) {
      await db
        .update(customers)
        .set({
          cumulativeRevenueSavedCents: cents,
          cumulativeRevenueLastComputedAt: asOf,
        })
        .where(eq(customers.id, c.id))
    }
  }

  return NextResponse.json({
    dryRun,
    asOf: asOf.toISOString(),
    customerCount: allCustomers.length,
    totalCentsAcrossAllCustomers: results.reduce((s, r) => s + r.cents, 0),
    results: dryRun ? results : undefined,
  })
}

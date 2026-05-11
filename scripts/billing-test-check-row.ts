// Did prod process the cancel webhook? Look for the wb_churned_subscribers
// row matching the test Stripe customer ID.
// Run: npx tsx --env-file=.env.local scripts/billing-test-check-row.ts <stripe_customer_id>

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, wbEvents } from '../lib/schema'
import { eq, desc, sql } from 'drizzle-orm'

async function main() {
  const stripeCustomerId = process.argv[2]
  if (!stripeCustomerId) { console.error('Usage: ... <stripe_customer_id>'); process.exit(1) }

  const subs = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.stripeCustomerId, stripeCustomerId))

  console.log(`wb_churned_subscribers rows for ${stripeCustomerId}: ${subs.length}`)
  for (const s of subs) {
    console.log({
      id: s.id, customerId: s.customerId, name: s.name, email: s.email,
      status: s.status, cancellationReason: s.cancellationReason,
      mrrCents: s.mrrCents, createdAt: s.createdAt?.toISOString(),
    })
  }

  // Also check recoveries
  const recs = subs.length > 0
    ? await db.select().from(recoveries).where(eq(recoveries.subscriberId, subs[0].id))
    : []
  console.log(`\nwb_recoveries rows: ${recs.length}`)
  for (const r of recs) {
    console.log({ id: r.id, recoveryType: r.recoveryType, planMrrCents: r.planMrrCents })
  }

  // Recent wb_events
  console.log(`\nLast 10 wb_events globally:`)
  const evs = await db
    .select({ id: wbEvents.id, name: wbEvents.name, createdAt: wbEvents.createdAt, properties: wbEvents.properties })
    .from(wbEvents)
    .orderBy(desc(wbEvents.createdAt))
    .limit(10)
  for (const e of evs) {
    const p = (e.properties ?? {}) as Record<string, unknown>
    console.log(`  ${e.createdAt?.toISOString()}  ${e.name}  ${JSON.stringify(p).slice(0, 120)}`)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

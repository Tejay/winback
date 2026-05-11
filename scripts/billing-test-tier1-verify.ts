// Tier 1.2 + 1.3 verification — read DB + Stripe state after Subscribe flow.
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier1-verify.ts

import { db } from '../lib/db'
import { customers, recoveries, users } from '../lib/schema'
import { eq, desc } from 'drizzle-orm'
import Stripe from 'stripe'

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c) { console.error('customer not found'); process.exit(1) }

  console.log('=== Tier 1.2 — customer billing state ===')
  console.log({
    activatedAt: c.activatedAt?.toISOString() ?? 'NULL ❌',
    stripeSubscriptionId: c.stripeSubscriptionId ?? 'NULL ❌',
    stripeSubscriptionCreatingAt: c.stripeSubscriptionCreatingAt?.toISOString() ?? 'NULL ✓ (lock released)',
    stripePlatformCustomerId: c.stripePlatformCustomerId,
    pilotUntil: c.pilotUntil?.toISOString() ?? 'NULL',
  })

  console.log('\n=== Tier 1.3 — recoveries + perf fee ===')
  const recs = await db.select().from(recoveries).where(eq(recoveries.customerId, c.id)).orderBy(desc(recoveries.recoveredAt))
  console.log(`recoveries: ${recs.length}`)
  for (const r of recs) {
    console.log({
      id: r.id,
      recoveryType: r.recoveryType,
      attributionType: r.attributionType,
      planMrrCents: r.planMrrCents,
      perfFeeStripeItemId: r.perfFeeStripeItemId ?? 'NULL ❌',
      perfFeeChargedAt: r.perfFeeChargedAt?.toISOString() ?? 'NULL ❌',
      perfFeeAmountCents: r.perfFeeAmountCents,
      perfFeeRefundedAt: r.perfFeeRefundedAt?.toISOString() ?? 'NULL (expected)',
    })
  }

  console.log('\n=== Platform Stripe subscription ===')
  if (!c.stripeSubscriptionId) {
    console.log('  no stripeSubscriptionId on customer — Subscribe flow did not complete')
  } else {
    const platform = new Stripe(process.env.STRIPE_SECRET_KEY!)
    const sub = await platform.subscriptions.retrieve(c.stripeSubscriptionId, { expand: ['items.data.price.product', 'latest_invoice'] }) as Stripe.Subscription
    console.log({
      id: sub.id,
      status: sub.status,
      customer: sub.customer,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentPeriodEnd: new Date(((sub as any).current_period_end ?? 0) * 1000).toISOString(),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
    })
    console.log('  Items:')
    for (const item of sub.items.data) {
      const price = item.price
      const product = price?.product as Stripe.Product | undefined
      console.log({
        item_id: item.id,
        price_id: price?.id,
        product_name: typeof product === 'object' ? product?.name : '(string ref)',
        unit_amount: price?.unit_amount,
        recurring: price?.recurring?.interval,
      })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inv = (sub as any).latest_invoice
    if (inv && typeof inv === 'object') {
      console.log('  Latest invoice:')
      console.log({
        id: inv.id,
        status: inv.status,
        amount_due: inv.amount_due,
        amount_paid: inv.amount_paid,
      })
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

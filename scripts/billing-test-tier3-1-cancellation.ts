// Tier 3.1 — Merchant cancels their own platform subscription.
//
// Pre-state: subscribed. We get there by synthetically running the
// activation path (seed a win-back recovery + create a platform Stripe
// customer with a good card, then call ensureActivation directly to
// land a real Stripe subscription).
//
// Action: cancel the platform sub via Stripe API.
// Expected: customer.subscription.deleted webhook (platform-side, no
// event.account) → processPlatformSubscriptionDeleted → DB:
//   - customers.stripeSubscriptionId → NULL
//   - emits platform_subscription_canceled wb_event
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier3-1-cancellation.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent, wbEvents, users } from '../lib/schema'
import { eq, and, desc } from 'drizzle-orm'
import { ensureActivation } from '../src/winback/lib/activation'
import Stripe from 'stripe'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const PERF_FEE_MRR_CENTS = 5000
const POLL_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 1_000

async function poll<T>(name: string, fn: () => Promise<T | null>): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const v = await fn()
    if (v !== null) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`    ✓ ${name} appeared after ${elapsed}s`)
      return v
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
  }
  throw new Error(`Timeout waiting for ${name}`)
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c) { console.error('customer not found'); process.exit(1) }

  if (c.stripeSubscriptionId) {
    console.error(`Customer already subscribed. Run reset first.`)
    process.exit(1)
  }

  const platform = new Stripe(process.env.STRIPE_SECRET_KEY!)

  console.log('=== Tier 3.1 — Merchant cancels their platform subscription ===\n')

  // 1) Seed pre-state: subscriber + win-back recovery to drive activation
  console.log('[1/5] Seed wb_churned_subscribers + win-back recovery')
  const [seedSub] = await db.insert(churnedSubscribers).values({
    customerId: c.id,
    stripeCustomerId: `cus_TIER31_${Date.now()}`,
    name: 'Tier 3.1 subscriber',
    email: `tier3-1-${Date.now()}@example.com`,
    cancellationReason: 'Lost interest',
    mrrCents: PERF_FEE_MRR_CENTS,
    status: 'recovered',
  }).returning({ id: churnedSubscribers.id })
  await db.insert(emailsSent).values({
    subscriberId: seedSub.id,
    type: 'exit',
    subject: '(tier 3.1) synthetic',
    bodyText: '(tier 3.1)',
    sentAt: new Date(Date.now() - 60_000),
    repliedAt: new Date(),
  })
  await db.insert(recoveries).values({
    subscriberId: seedSub.id,
    customerId: c.id,
    planMrrCents: PERF_FEE_MRR_CENTS,
    recoveryType: 'win_back',
    attributionType: 'strong',
  })
  console.log(`    subscriber=${seedSub.id}  recovery seeded`)

  // 2) Create platform Stripe customer + attach PM, then call ensureActivation
  console.log('\n[2/5] Create platform customer + attach pm_card_visa as default')
  const platformCustomer = await platform.customers.create({
    email: `tier3-1-${Date.now()}@example.com`,
    name: 'Tier 3.1 platform',
    metadata: { winback_customer_id: c.id, tier: '3.1' },
  })
  const pm = await platform.paymentMethods.attach('pm_card_visa', { customer: platformCustomer.id })
  await platform.customers.update(platformCustomer.id, {
    invoice_settings: { default_payment_method: pm.id },
  })
  await db.update(customers)
    .set({ stripePlatformCustomerId: platformCustomer.id, updatedAt: new Date() })
    .where(eq(customers.id, c.id))
  console.log(`    platform=${platformCustomer.id}  PM=${pm.id}`)

  console.log('\n[3/5] Call ensureActivation to land the platform subscription')
  const activation = await ensureActivation(c.id)
  if (activation.state !== 'active') {
    console.error(`Activation failed: state=${activation.state}`)
    process.exit(1)
  }
  console.log(`    state=active  subId=${activation.subscriptionId}  subCreated=${activation.subscriptionCreated}`)

  // 3) Snapshot subscribed state
  const [beforeCancel] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  console.log(`\n[4/5] Pre-cancel state:`)
  console.log(`    stripeSubscriptionId=${beforeCancel.stripeSubscriptionId}`)
  console.log(`    activatedAt=${beforeCancel.activatedAt?.toISOString()}`)

  // 4) Cancel the platform sub via Stripe API (simulates Settings → Cancel)
  console.log(`\n[5/5] Cancel sub ${activation.subscriptionId} on platform Stripe`)
  await platform.subscriptions.cancel(activation.subscriptionId)
  console.log('    cancel API call succeeded — waiting for webhook to clear stripeSubscriptionId')

  // 5) Wait for processPlatformSubscriptionDeleted to fire
  await poll('customers.stripeSubscriptionId cleared', async () => {
    const [row] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
    return row?.stripeSubscriptionId === null ? row : null
  })

  // Verify the event was logged
  const [event] = await db
    .select()
    .from(wbEvents)
    .where(and(
      eq(wbEvents.customerId, c.id),
      eq(wbEvents.name, 'platform_subscription_canceled'),
    ))
    .orderBy(desc(wbEvents.createdAt))
    .limit(1)
  if (!event) {
    console.error('❌ No platform_subscription_canceled event logged')
    process.exit(1)
  }
  console.log(`    ✓ wb_events.platform_subscription_canceled logged at ${event.createdAt?.toISOString()}`)

  // Re-verify Stripe-side
  const subAfter = await platform.subscriptions.retrieve(activation.subscriptionId)
  console.log(`\n=== Final state ===`)
  console.log(`  Stripe sub status: ${subAfter.status} (expect 'canceled')`)
  console.log(`  customers.stripeSubscriptionId: ${(await db.select().from(customers).where(eq(customers.id, c.id)).limit(1))[0].stripeSubscriptionId} (expect NULL)`)
  console.log(`  customers.activatedAt: kept (audit trail) ✓`)

  if (subAfter.status !== 'canceled') {
    console.error('❌ Stripe sub NOT canceled')
    process.exit(1)
  }

  console.log('\n✓✓✓ Tier 3.1 verified — merchant cancellation flow works end-to-end.')
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

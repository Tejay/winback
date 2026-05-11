// Tier 1.1 — Real Stripe webhook chain on tejaasvi@gmail.com's Connect account.
//
// Creates one test subscriber, cancels them (→ webhook → processChurn → exit
// email + classifier), then re-subscribes them (→ webhook → processRecovery
// → activation). At the end, verifies wb_churned_subscribers + wb_recoveries
// rows + activatedAt is set on the customer row.
//
// Prerequisite: dev server + stripe listen + ngrok all running so webhooks
// reach /api/stripe/webhook. Stripe listen MUST be forwarding Connect events.
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier1-real-webhook.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, users } from '../lib/schema'
import { eq, and } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const TEST_SUB_EMAIL = `billing-test-${Date.now()}@example.com`
const TEST_SUB_NAME = 'Billing Test Subscriber'
const PLAN_MRR_CENTS = 5000 // $50/mo
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
  throw new Error(`Timeout waiting for ${name} (${POLL_TIMEOUT_MS / 1000}s)`)
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  if (!u) { console.error(`user ${TARGET_EMAIL} not found`); process.exit(1) }
  const [c] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c?.stripeAccessToken) { console.error(`no Connect token for ${TARGET_EMAIL}`); process.exit(1) }

  // Sanity: customer should be at pre-first-recovery baseline
  if (c.activatedAt || c.stripeSubscriptionId) {
    console.error(`Customer is NOT at baseline. activatedAt=${c.activatedAt} subId=${c.stripeSubscriptionId}`)
    console.error('Run scripts/billing-test-reset.ts first.')
    process.exit(1)
  }

  const connect = new Stripe(decrypt(c.stripeAccessToken))

  console.log('=== Tier 1.1 — Real Stripe webhook chain ===')
  console.log(`Target: ${TARGET_EMAIL}  customerId=${c.id}`)
  console.log(`Test subscriber: ${TEST_SUB_EMAIL}\n`)

  // 1) Create / reuse a Price on Connect
  console.log('[1/6] Get-or-create Price on Connect ($50/mo)')
  let price: Stripe.Price | null = null
  const existingPrices = await connect.prices.list({ limit: 100, active: true })
  price = existingPrices.data.find(p =>
    p.unit_amount === PLAN_MRR_CENTS &&
    p.currency === 'usd' &&
    p.recurring?.interval === 'month'
  ) ?? null
  if (!price) {
    const product = await connect.products.create({ name: 'Tier 1 Test Plan' })
    price = await connect.prices.create({
      unit_amount: PLAN_MRR_CENTS,
      currency: 'usd',
      recurring: { interval: 'month' },
      product: product.id,
    })
    console.log(`    created ${price.id}`)
  } else {
    console.log(`    reused ${price.id}`)
  }

  // 2) Create test customer
  console.log('[2/6] Create test customer on Connect')
  const stripeCustomer = await connect.customers.create({
    email: TEST_SUB_EMAIL,
    name: TEST_SUB_NAME,
  })
  console.log(`    ${stripeCustomer.id}`)

  // 3) Create subscription (send_invoice → no PM needed for test)
  console.log('[3/6] Create active subscription (collection_method=send_invoice)')
  const sub1 = await connect.subscriptions.create({
    customer: stripeCustomer.id,
    items: [{ price: price.id }],
    collection_method: 'send_invoice',
    days_until_due: 30,
  })
  console.log(`    ${sub1.id}  status=${sub1.status}`)

  // 4) Cancel — fires customer.subscription.deleted → processChurn
  console.log('\n[4/6] Cancel subscription → expect processChurn webhook')
  await connect.subscriptions.cancel(sub1.id)
  console.log(`    sub canceled, polling wb_churned_subscribers...`)

  const churnRow = await poll('wb_churned_subscribers row', async () => {
    const [row] = await db
      .select()
      .from(churnedSubscribers)
      .where(and(
        eq(churnedSubscribers.customerId, c.id),
        eq(churnedSubscribers.stripeCustomerId, stripeCustomer.id),
      ))
      .limit(1)
    return row ?? null
  })
  console.log(`    subscriber id=${churnRow.id}`)
  console.log(`    name=${churnRow.name} email=${churnRow.email}`)
  console.log(`    cancellationReason=${churnRow.cancellationReason ?? '(awaiting classifier)'}`)
  console.log(`    mrrCents=${churnRow.mrrCents} status=${churnRow.status}`)

  // 5) Re-subscribe → fires customer.subscription.created → processRecovery
  console.log('\n[5/6] Re-create subscription → expect processRecovery webhook')
  const sub2 = await connect.subscriptions.create({
    customer: stripeCustomer.id,
    items: [{ price: price.id }],
    collection_method: 'send_invoice',
    days_until_due: 30,
  })
  console.log(`    ${sub2.id}  status=${sub2.status}`)
  console.log(`    polling wb_recoveries...`)

  const recRow = await poll('wb_recoveries row', async () => {
    const [row] = await db
      .select()
      .from(recoveries)
      .where(and(
        eq(recoveries.customerId, c.id),
        eq(recoveries.subscriberId, churnRow.id),
      ))
      .limit(1)
    return row ?? null
  })
  console.log(`    recovery id=${recRow.id}`)
  console.log(`    type=${recRow.recoveryType} planMrrCents=${recRow.planMrrCents}`)
  console.log(`    perfFeeStripeItemId=${recRow.perfFeeStripeItemId ?? 'NULL (expected pre-subscribe)'}`)
  console.log(`    perfFeeChargedAt=${recRow.perfFeeChargedAt?.toISOString() ?? 'NULL (expected pre-subscribe)'}`)

  // 6) Verify customer state
  console.log('\n[6/6] Verify customer billing state')
  const [after] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  console.log(`    activatedAt=${after.activatedAt?.toISOString() ?? 'NULL ❌ expected non-null'}`)
  console.log(`    stripeSubscriptionId=${after.stripeSubscriptionId ?? 'NULL (expected — not yet subscribed)'}`)
  console.log(`    pilotUntil=${after.pilotUntil?.toISOString() ?? 'NULL (expected — not on pilot)'}`)

  console.log('\n=== Now ===')
  console.log(`Open  http://localhost:3000/dashboard  (logged in as ${TARGET_EMAIL})`)
  console.log(`Expect:`)
  console.log(`  • "Your first recovery — Subscribe to continue" banner (or similar copy)`)
  console.log(`  • Subscriber "${churnRow.name}" listed`)
  console.log(`  • CTA button to start Stripe Checkout`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('\nFAILED:', e); process.exit(1) })

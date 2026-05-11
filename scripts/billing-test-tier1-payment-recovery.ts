// Tier 1 (variant) — payment recovery (dunning) as the FIRST event.
//
// Why this script doesn't simulate a real failed charge:
// Stripe's newer API runs validation against the card at PaymentMethod
// attach time, so pre-built declined PMs (`pm_card_visa_chargeDeclined`,
// `tok_chargeDeclined`) fail with `card_declined` *before* we can even
// attach them to the test customer. That makes the "create sub with
// failing card → invoice.payment_failed" approach unusable from outside
// Stripe Checkout.
//
// Instead we drive the recovery half of the dunning flow with a real
// Stripe customer + good card, while seeding the pre-recovery row in our
// DB to simulate the prior failure. That exercises the path that
// matters for billing:
//   processPaymentSucceeded → match by stripeCustomerId →
//     attributionType='strong' (via billingPortalClickedAt) →
//     wb_recoveries(recoveryType='card_save', perf_fee=NULL) →
//     triggerActivation('dunning_recovery') → activatedAt set.
//
// processPaymentFailed has its own unit tests; this script doesn't need
// to re-prove that the dunning row gets created — only that, once
// created, a real Stripe payment_succeeded gets attributed as card_save
// with the right billing characteristics (no perf fee).
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier1-payment-recovery.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, users } from '../lib/schema'
import { eq, and } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const TEST_SUB_EMAIL = `billing-test-${Date.now()}@example.com`
const TEST_SUB_NAME = 'Payment Recovery Test'
const PLAN_MRR_CENTS = 5000
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
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c?.stripeAccessToken) { console.error(`no Connect token`); process.exit(1) }

  if (c.activatedAt || c.stripeSubscriptionId) {
    console.error(`Customer NOT at baseline. activatedAt=${c.activatedAt} subId=${c.stripeSubscriptionId}`)
    console.error('Run scripts/billing-test-reset.ts first.')
    process.exit(1)
  }

  const connect = new Stripe(decrypt(c.stripeAccessToken))

  console.log('=== Tier 1 — Payment recovery (card_save) as first event ===')
  console.log(`Target: ${TARGET_EMAIL}  customerId=${c.id}`)
  console.log(`Test subscriber: ${TEST_SUB_EMAIL}\n`)

  // 1) Reuse the $50/mo Price
  console.log('[1/6] Get-or-create Price on Connect ($50/mo)')
  const prices = await connect.prices.list({ limit: 100, active: true })
  let price = prices.data.find(p =>
    p.unit_amount === PLAN_MRR_CENTS && p.currency === 'usd' && p.recurring?.interval === 'month'
  )
  if (!price) {
    const product = await connect.products.create({ name: 'Tier 1 Test Plan' })
    price = await connect.prices.create({
      unit_amount: PLAN_MRR_CENTS,
      currency: 'usd',
      recurring: { interval: 'month' },
      product: product.id,
    })
  }
  console.log(`    ${price.id}`)

  // 2) Create test customer on Connect — real Stripe object so the
  // webhook handler's stripeCustomerId match works.
  console.log('[2/6] Create real Stripe customer on Connect')
  const stripeCustomer = await connect.customers.create({
    email: TEST_SUB_EMAIL,
    name: TEST_SUB_NAME,
  })
  console.log(`    ${stripeCustomer.id}`)

  // 3) Seed wb_churned_subscribers as if processPaymentFailed already ran.
  // Includes the signals that drive attributionType='strong' in
  // processPaymentSucceeded:
  //   - cancellationReason='Payment failed' (required gate)
  //   - dunningState='awaiting_retry' (any non-null value would work for
  //     attribution; we pick the realistic state)
  //   - billingPortalClickedAt (strong attribution)
  //   - paymentMethodAtFailure (set so PM-change comparison would also
  //     be strong, but billingPortalClickedAt takes priority)
  console.log('[3/6] Seed wb_churned_subscribers (cancellationReason=Payment failed)')
  const [seeded] = await db.insert(churnedSubscribers).values({
    customerId: c.id,
    stripeCustomerId: stripeCustomer.id,
    name: TEST_SUB_NAME,
    email: TEST_SUB_EMAIL,
    cancellationReason: 'Payment failed',
    dunningState: 'awaiting_retry',
    mrrCents: PLAN_MRR_CENTS,
    status: 'lost',
    paymentMethodAtFailure: 'pm_card_THAT_FAILED',
    billingPortalClickedAt: new Date(),
    stripeSubscriptionId: null,
  }).returning({ id: churnedSubscribers.id })
  console.log(`    subscriber id=${seeded.id}`)

  // 4) Attach a good card and create a real subscription. Stripe will
  // charge immediately → invoice.payment_succeeded → processPaymentSucceeded.
  // NB: attach() clones the shared test PM and returns a new specific
  // PM ID — must use that, not the literal 'pm_card_visa' string.
  console.log('[4/6] Attach pm_card_visa + create subscription (charge_automatically)')
  const attachedPM = await connect.paymentMethods.attach('pm_card_visa', { customer: stripeCustomer.id })
  await connect.customers.update(stripeCustomer.id, {
    invoice_settings: { default_payment_method: attachedPM.id },
  })
  console.log(`    PM attached as ${attachedPM.id}`)
  const sub = await connect.subscriptions.create({
    customer: stripeCustomer.id,
    items: [{ price: price.id }],
  })
  console.log(`    subscription=${sub.id}  status=${sub.status}`)

  // 5) Wait for processPaymentSucceeded → wb_recoveries (recoveryType='card_save')
  console.log('\n[5/6] Wait for processPaymentSucceeded → wb_recoveries (card_save)')
  const recRow = await poll('wb_recoveries (card_save)', async () => {
    const [row] = await db
      .select()
      .from(recoveries)
      .where(and(
        eq(recoveries.customerId, c.id),
        eq(recoveries.subscriberId, seeded.id),
      ))
      .limit(1)
    return row ?? null
  })
  console.log(`    recovery id=${recRow.id}`)
  console.log(`    recoveryType=${recRow.recoveryType}  attributionType=${recRow.attributionType}`)
  console.log(`    planMrrCents=${recRow.planMrrCents}`)
  console.log(`    perfFeeStripeItemId=${recRow.perfFeeStripeItemId ?? 'NULL ✓ (card_save — no perf fee)'}`)
  console.log(`    perfFeeChargedAt=${recRow.perfFeeChargedAt?.toISOString() ?? 'NULL ✓'}`)

  // 6) Poll for activation
  console.log('\n[6/6] Poll customers.activatedAt')
  const activatedRow = await poll('customers.activatedAt populated', async () => {
    const [row] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
    return row?.activatedAt ? row : null
  })
  console.log(`    activatedAt=${activatedRow.activatedAt?.toISOString()} ✓`)
  console.log(`    stripeSubscriptionId=${activatedRow.stripeSubscriptionId ?? 'NULL (expected — not yet subscribed)'}`)
  console.log(`    stripePlatformCustomerId=${activatedRow.stripePlatformCustomerId ?? 'NULL'}`)

  console.log('\n=== Now ===')
  console.log(`Open  http://localhost:3000/dashboard  (logged in as ${TARGET_EMAIL})`)
  console.log(`Expect:`)
  console.log(`  • First-recovery banner (this time the recovery is card_save)`)
  console.log(`  • Subscriber "${TEST_SUB_NAME}" visible in the Payment recoveries tab`)
  console.log(`  • Click Subscribe — first invoice should be $99 only (no $50 perf fee)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

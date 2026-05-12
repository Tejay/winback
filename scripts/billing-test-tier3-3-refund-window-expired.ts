// Tier 3.3 — Subscriber re-cancels AFTER the 14-day refund window.
//
// Negative test for the 14-day refund gate. Same setup as Tier 3.2:
//   1. Real cancel + re-subscribe (creates win-back recovery)
//   2. ensureActivation → perf fee charged
//   3. BACKDATE perf_fee_charged_at to 15 days ago (simulates aged charge)
//   4. Cancel the subscriber → processChurn → maybeRefundRecentWinBack
//   5. The 14-day cutoff filters the recovery OUT — no refund should fire
//
// Verification: wb_recoveries.perf_fee_refunded_at stays NULL, no credit
// note created on Stripe.
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier3-3-refund-window-expired.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent, users } from '../lib/schema'
import { eq, and } from 'drizzle-orm'
import { ensureActivation } from '../src/winback/lib/activation'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const TEST_SUB_EMAIL = `billing-test-${Date.now()}@example.com`
const PLAN_MRR_CENTS = 5000
const POLL_TIMEOUT_MS = 30_000

async function poll<T>(name: string, fn: () => Promise<T | null>): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const v = await fn()
    if (v !== null) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`    ✓ ${name} appeared after ${elapsed}s`)
      return v
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`Timeout waiting for ${name}`)
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c?.stripeAccessToken) { console.error('no Connect token'); process.exit(1) }
  if (c.stripeSubscriptionId || c.activatedAt) {
    console.error('Customer NOT at baseline. Run reset first.'); process.exit(1)
  }

  const connect = new Stripe(decrypt(c.stripeAccessToken), { apiVersion: '2026-03-25.dahlia' })
  const platform = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-03-25.dahlia' })

  console.log('=== Tier 3.3 — Refund window EXPIRED (negative test) ===\n')

  // [1] Run the cancel + re-subscribe flow (real Stripe webhooks)
  console.log('[1/8] Get-or-create $50/mo Price')
  const prices = await connect.prices.list({ limit: 100, active: true })
  let price = prices.data.find(p =>
    p.unit_amount === PLAN_MRR_CENTS && p.currency === 'usd' && p.recurring?.interval === 'month'
  )
  if (!price) {
    const product = await connect.products.create({ name: 'Tier 3.3 plan' })
    price = await connect.prices.create({
      unit_amount: PLAN_MRR_CENTS, currency: 'usd',
      recurring: { interval: 'month' }, product: product.id,
    })
  }

  console.log('[2/8] Create subscriber + cancel (initial churn webhook)')
  const stripeCustomer = await connect.customers.create({ email: TEST_SUB_EMAIL, name: 'Tier 3.3' })
  const sub1 = await connect.subscriptions.create({
    customer: stripeCustomer.id, items: [{ price: price.id }],
    collection_method: 'send_invoice', days_until_due: 30,
  })
  await connect.subscriptions.cancel(sub1.id)
  const churnRow = await poll('wb_churned_subscribers row', async () => {
    const [row] = await db.select().from(churnedSubscribers)
      .where(and(eq(churnedSubscribers.customerId, c.id), eq(churnedSubscribers.stripeCustomerId, stripeCustomer.id)))
      .limit(1)
    return row ?? null
  })

  console.log('[3/8] Inject synthetic exit email (strong attribution)')
  await db.insert(emailsSent).values({
    subscriberId: churnRow.id, type: 'exit',
    subject: '(tier 3.3) synthetic', bodyText: '(tier 3.3)',
    sentAt: new Date(Date.now() - 60_000), repliedAt: new Date(),
  })

  console.log('[4/8] Re-subscribe (recovery webhook)')
  const sub2 = await connect.subscriptions.create({
    customer: stripeCustomer.id, items: [{ price: price.id }],
    collection_method: 'send_invoice', days_until_due: 30,
  })
  const recRow = await poll('wb_recoveries row', async () => {
    const [row] = await db.select().from(recoveries)
      .where(and(eq(recoveries.customerId, c.id), eq(recoveries.subscriberId, churnRow.id)))
      .limit(1)
    return row ?? null
  })

  console.log('[5/8] Set up platform Stripe + ensureActivation → perf fee charged')
  const platformCustomer = await platform.customers.create({
    email: `tier3-3-${Date.now()}@example.com`, name: 'Tier 3.3 platform',
    metadata: { winback_customer_id: c.id, tier: '3.3' },
  })
  const pm = await platform.paymentMethods.attach('pm_card_visa', { customer: platformCustomer.id })
  await platform.customers.update(platformCustomer.id, {
    invoice_settings: { default_payment_method: pm.id },
  })
  await db.update(customers).set({ stripePlatformCustomerId: platformCustomer.id, updatedAt: new Date() }).where(eq(customers.id, c.id))
  const activation = await ensureActivation(c.id)
  if (activation.state !== 'active') { console.error(`activation state=${activation.state}`); process.exit(1) }
  const [recAfterCharge] = await db.select().from(recoveries).where(eq(recoveries.id, recRow.id)).limit(1)
  if (!recAfterCharge.perfFeeChargedAt) { console.error('perf fee not charged'); process.exit(1) }
  console.log(`    perf fee item=${recAfterCharge.perfFeeStripeItemId} chargedAt=${recAfterCharge.perfFeeChargedAt.toISOString()}`)

  // === The pivot from Tier 3.2: BACKDATE the charge timestamp ===
  console.log('\n[6/8] BACKDATE perf_fee_charged_at to 15 days ago')
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
  await db.update(recoveries)
    .set({ perfFeeChargedAt: fifteenDaysAgo })
    .where(eq(recoveries.id, recRow.id))
  console.log(`    perfFeeChargedAt now = ${fifteenDaysAgo.toISOString()} (>14d ago)`)

  // Snapshot state BEFORE cancel
  const beforeCancel = {
    perfFeeRefundedAt: recAfterCharge.perfFeeRefundedAt,
    invoiceItemId: recAfterCharge.perfFeeStripeItemId,
  }

  // [7] Cancel the subscriber → processChurn → maybeRefundRecentWinBack should
  // find NOTHING refundable (14-day filter excludes our 15-day-old recovery)
  console.log(`\n[7/8] Cancel subscriber's subscription → should NOT trigger refund`)
  await connect.subscriptions.cancel(sub2.id)
  console.log('    Waiting 6s for processChurn to run...')
  await new Promise(r => setTimeout(r, 6_000))

  // [8] Verify
  console.log('\n[8/8] Verify refund did NOT fire')
  const [recAfterCancel] = await db.select().from(recoveries).where(eq(recoveries.id, recRow.id)).limit(1)
  console.log(`    wb_recoveries.perf_fee_refunded_at = ${recAfterCancel.perfFeeRefundedAt?.toISOString() ?? 'NULL ✓ (expected — outside 14d window)'}`)

  if (recAfterCancel.perfFeeRefundedAt) {
    console.error('\n❌ FAILURE — refund fired despite being outside the 14-day window')
    process.exit(1)
  }

  // Verify Stripe side too — invoice item should still exist, no credit note for it
  const item = await platform.invoiceItems.retrieve(recAfterCharge.perfFeeStripeItemId!)
  const invoiceId = typeof item.invoice === 'string' ? item.invoice : item.invoice?.id ?? null
  console.log(`    Stripe item ${item.id} still exists ✓  (invoice=${invoiceId ?? 'unattached'})`)

  if (invoiceId) {
    const creditNotes = await platform.creditNotes.list({ invoice: invoiceId, limit: 5 })
    if (creditNotes.data.length > 0) {
      console.error(`    ❌ ${creditNotes.data.length} credit note(s) exist for this invoice — refund did happen!`)
      process.exit(1)
    }
    console.log(`    No credit notes on invoice ${invoiceId} ✓`)
  }

  console.log('\n✓✓✓ Tier 3.3 verified — refund correctly suppressed outside 14-day window.')
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

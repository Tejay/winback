// Tier 3.2 — Subscriber re-cancels within the 14-day refund window.
//
// Flow:
//   1. Real cancel + re-subscribe on Connect (creates wb_churned_subscribers + wb_recoveries)
//   2. Inject synthetic wb_emails_sent (with repliedAt) so attribution=strong
//      and ensureActivation will actually charge the perf fee
//   3. Set up platform Stripe customer + card, call ensureActivation →
//      platform subscription created, perf fee charged
//   4. Cancel the SUBSCRIBER's re-subscription on Connect → processChurn fires →
//      maybeRefundRecentWinBack → refundPerformanceFee
//   5. Verify wb_recoveries.perf_fee_refunded_at is set, and the Stripe-side
//      invoice item was either deleted or credit-noted.
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier3-2-refund-within-window.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent, users } from '../lib/schema'
import { eq, and } from 'drizzle-orm'
import { ensureActivation } from '../src/winback/lib/activation'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const TEST_SUB_EMAIL = `billing-test-${Date.now()}@example.com`
const TEST_SUB_NAME = 'Tier 3.2 Refund Subscriber'
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
  throw new Error(`Timeout waiting for ${name}`)
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c?.stripeAccessToken) { console.error('no Connect token'); process.exit(1) }
  if (c.stripeSubscriptionId || c.activatedAt) {
    console.error('Customer NOT at baseline. Run reset first.')
    process.exit(1)
  }

  const connect = new Stripe(decrypt(c.stripeAccessToken))
  const platform = new Stripe(process.env.STRIPE_SECRET_KEY!)

  console.log('=== Tier 3.2 — Refund within 14-day window ===\n')

  // [1] Real win-back flow: cancel + re-subscribe via Connect API
  console.log('[1/7] Get-or-create $50/mo Price')
  const prices = await connect.prices.list({ limit: 100, active: true })
  let price = prices.data.find(p =>
    p.unit_amount === PLAN_MRR_CENTS && p.currency === 'usd' && p.recurring?.interval === 'month'
  )
  if (!price) {
    const product = await connect.products.create({ name: 'Tier 3.2 plan' })
    price = await connect.prices.create({
      unit_amount: PLAN_MRR_CENTS, currency: 'usd',
      recurring: { interval: 'month' }, product: product.id,
    })
  }

  console.log('[2/7] Create test subscriber + cancel + verify churn row')
  const stripeCustomer = await connect.customers.create({ email: TEST_SUB_EMAIL, name: TEST_SUB_NAME })
  const sub1 = await connect.subscriptions.create({
    customer: stripeCustomer.id, items: [{ price: price.id }],
    collection_method: 'send_invoice', days_until_due: 30,
  })
  await connect.subscriptions.cancel(sub1.id)
  const churnRow = await poll('wb_churned_subscribers (initial churn)', async () => {
    const [row] = await db.select().from(churnedSubscribers)
      .where(and(eq(churnedSubscribers.customerId, c.id), eq(churnedSubscribers.stripeCustomerId, stripeCustomer.id)))
      .limit(1)
    return row ?? null
  })
  console.log(`    subscriber=${churnRow.id}`)

  // [3] Inject synthetic exit email with repliedAt → strong attribution on the recovery
  await db.insert(emailsSent).values({
    subscriberId: churnRow.id, type: 'exit',
    subject: '(tier 3.2) synthetic', bodyText: '(tier 3.2)',
    sentAt: new Date(Date.now() - 60_000),
    repliedAt: new Date(),
  })
  console.log('[3/7] Synthetic exit-email row inserted (repliedAt set)')

  // [4] Re-subscribe → wb_recoveries row, strong attribution
  console.log('[4/7] Re-subscribe → expect wb_recoveries row (strong)')
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
  console.log(`    recovery=${recRow.id}  type=${recRow.recoveryType}  attribution=${recRow.attributionType}`)

  // [5] Set up platform Stripe + call ensureActivation → perf fee charged
  console.log('\n[5/7] Set up platform customer + ensureActivation → perf fee charged')
  const platformCustomer = await platform.customers.create({
    email: `tier3-2-${Date.now()}@example.com`, name: 'Tier 3.2 platform',
    metadata: { winback_customer_id: c.id, tier: '3.2' },
  })
  const pm = await platform.paymentMethods.attach('pm_card_visa', { customer: platformCustomer.id })
  await platform.customers.update(platformCustomer.id, {
    invoice_settings: { default_payment_method: pm.id },
  })
  await db.update(customers).set({ stripePlatformCustomerId: platformCustomer.id, updatedAt: new Date() }).where(eq(customers.id, c.id))
  const activation = await ensureActivation(c.id)
  if (activation.state !== 'active') { console.error(`activation state=${activation.state}`); process.exit(1) }
  console.log(`    activation: state=active subId=${activation.subscriptionId} subCreated=${activation.subscriptionCreated}`)

  const [recAfterCharge] = await db.select().from(recoveries).where(eq(recoveries.id, recRow.id)).limit(1)
  if (!recAfterCharge.perfFeeStripeItemId || !recAfterCharge.perfFeeChargedAt) {
    console.error(`Perf fee NOT charged: itemId=${recAfterCharge.perfFeeStripeItemId} chargedAt=${recAfterCharge.perfFeeChargedAt}`)
    process.exit(1)
  }
  console.log(`    ✓ perf fee charged: item=${recAfterCharge.perfFeeStripeItemId} chargedAt=${recAfterCharge.perfFeeChargedAt?.toISOString()}`)

  // [6] Cancel the subscriber's re-subscribed sub on Connect → triggers refund path
  console.log(`\n[6/7] Cancel subscriber's re-subscription (sub ${sub2.id}) → triggers refund`)
  await connect.subscriptions.cancel(sub2.id)

  // [7] Wait for refund to land
  const refunded = await poll('wb_recoveries.perf_fee_refunded_at set', async () => {
    const [row] = await db.select().from(recoveries).where(eq(recoveries.id, recRow.id)).limit(1)
    return row?.perfFeeRefundedAt ? row : null
  })
  console.log(`    ✓ perf_fee_refunded_at=${refunded.perfFeeRefundedAt?.toISOString()}`)

  // Verify Stripe-side: item should be deleted OR a credit note created
  console.log(`\n[verify] Stripe-side state of invoice item ${recAfterCharge.perfFeeStripeItemId}`)
  let itemStillExists = false
  let invoiceId: string | null = null
  try {
    const item = await platform.invoiceItems.retrieve(recAfterCharge.perfFeeStripeItemId!)
    itemStillExists = true
    invoiceId = typeof item.invoice === 'string' ? item.invoice : item.invoice?.id ?? null
    console.log(`    item still exists; invoice=${invoiceId}`)
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing') {
      console.log(`    ✓ item DELETED (refund method: delete_item)`)
    } else { throw err }
  }
  if (itemStillExists && invoiceId) {
    const creditNotes = await platform.creditNotes.list({ invoice: invoiceId, limit: 5 })
    if (creditNotes.data.length > 0) {
      console.log(`    ✓ ${creditNotes.data.length} credit note(s) created against invoice ${invoiceId}`)
      for (const cn of creditNotes.data) {
        console.log(`      ${cn.id}  amount=${cn.amount}  status=${cn.status}`)
      }
    } else {
      console.error(`    ❌ item still on invoice ${invoiceId} but NO credit note found`)
      process.exit(1)
    }
  }

  console.log('\n✓✓✓ Tier 3.2 verified — 14-day refund window fires correctly.')
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

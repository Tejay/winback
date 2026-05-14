// Spec 67 — seed a REAL charged-perf-fee row backed by a real Stripe
// test-mode invoice item, so /admin/billing's new section + Refund button
// can be exercised end-to-end. The invoice item is created pending (not
// attached to a finalized invoice), so refund will hit the delete-item
// branch and clean up cleanly.
//
//   seed:    npx tsx --env-file=.env.local scripts/smoke-spec67-seed.ts seed
//   cleanup: npx tsx --env-file=.env.local scripts/smoke-spec67-seed.ts cleanup

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, users } from '../lib/schema'
import { eq, inArray } from 'drizzle-orm'
import { getPlatformStripe } from '../src/winback/lib/platform-stripe'
import * as fs from 'node:fs'

const DEV_USER_EMAIL = 'tejaasvi@gmail.com'
const TAG = 'spec67-smoke'
const MARKER_FILE = '/tmp/.spec67-smoke-recoveries'

function readMarkers(): string[] {
  if (!fs.existsSync(MARKER_FILE)) return []
  return fs.readFileSync(MARKER_FILE, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
}

function appendMarker(id: string) {
  fs.appendFileSync(MARKER_FILE, id + '\n')
}

function clearMarkers() {
  if (fs.existsSync(MARKER_FILE)) fs.unlinkSync(MARKER_FILE)
}

async function getDevCustomer() {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, DEV_USER_EMAIL)).limit(1)
  if (!user) throw new Error(`User ${DEV_USER_EMAIL} not found`)
  const [c] = await db.select().from(customers).where(eq(customers.userId, user.id)).limit(1)
  if (!c) throw new Error('Dev customer not found')
  return c
}

async function ensurePlatformCustomer(customer: { id: string; stripePlatformCustomerId: string | null }): Promise<string> {
  const stripe = getPlatformStripe()
  if (customer.stripePlatformCustomerId) {
    await ensureDefaultCard(customer.stripePlatformCustomerId)
    return customer.stripePlatformCustomerId
  }
  const created = await stripe.customers.create({
    email: `${TAG}-platform-${Date.now()}@example.com`,
    name: 'Spec 67 smoke platform customer',
    metadata: { winback_smoke: TAG },
  })
  await db
    .update(customers)
    .set({ stripePlatformCustomerId: created.id })
    .where(eq(customers.id, customer.id))
  console.log(`  · created platform Stripe customer: ${created.id}`)
  await ensureDefaultCard(created.id)
  return created.id
}

/**
 * Ensure the platform Stripe customer has a working default payment
 * method so we can actually pay an invoice in test mode. Uses Stripe's
 * `pm_card_visa` test method (always charges successfully).
 */
async function ensureDefaultCard(platformCustomerId: string): Promise<void> {
  const stripe = getPlatformStripe()
  const cust = await stripe.customers.retrieve(platformCustomerId)
  if (cust.deleted) throw new Error('platform customer is deleted')
  const defaultPm = cust.invoice_settings?.default_payment_method
  if (defaultPm) return
  const pm = await stripe.paymentMethods.attach('pm_card_visa', { customer: platformCustomerId })
  await stripe.customers.update(platformCustomerId, {
    invoice_settings: { default_payment_method: pm.id },
  })
  console.log(`  · attached test card pm_card_visa as default`)
}

async function seed() {
  const customer = await getDevCustomer()
  console.log('Dev customer:', customer.id)

  const platformCustomerId = await ensurePlatformCustomer(customer)
  const stripe = getPlatformStripe()

  // 1. Create an empty invoice first. Stripe's pending-item auto-attach
  //    behaviour is unreliable across API versions, so we attach the item
  //    explicitly to this invoice id in the next step.
  const invoice = await stripe.invoices.create({
    customer: platformCustomerId,
    auto_advance: false,
    collection_method: 'charge_automatically',
    description: `[${TAG}] Smoke invoice bundling perf fee`,
  })
  if (!invoice.id) throw new Error('invoice created without id')
  console.log(`  · created draft invoice: ${invoice.id}`)

  // 2. Create the perf-fee invoice item attached directly to the draft.
  const item = await stripe.invoiceItems.create({
    customer: platformCustomerId,
    invoice: invoice.id,
    amount: 2900,
    currency: 'usd',
    description: `[${TAG}] Smoke win-back fee`,
    metadata: { winback_smoke: TAG },
  })
  console.log(`  · attached invoice item: ${item.id}`)

  // 3. Finalize + pay. With auto_advance: false, finalize leaves the
  //    invoice in 'open' status — we have to call pay() explicitly to
  //    charge the default card. (With auto_advance: true Stripe would
  //    auto-pay, but then the timing of any explicit pay() call races
  //    and 400s with "Invoice is already paid", so we drive both
  //    steps manually for determinism.)
  await stripe.invoices.finalizeInvoice(invoice.id)
  const paid = await stripe.invoices.pay(invoice.id)
  console.log(`  · finalized + paid: status=${paid.status} amount=$${(paid.amount_paid / 100).toFixed(2)}`)
  if (paid.status !== 'paid') {
    throw new Error(`expected invoice status 'paid', got '${paid.status}' (amount_paid=${paid.amount_paid})`)
  }

  const [existingSub] = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.customerId, customer.id))
    .limit(1)

  let subscriberId: string
  if (existingSub) {
    subscriberId = existingSub.id
  } else {
    const [inserted] = await db
      .insert(churnedSubscribers)
      .values({
        customerId: customer.id,
        stripeCustomerId: `cus_${TAG}_${Date.now()}`,
        email: `${TAG}@example.com`,
        name: 'Smoke subscriber',
        planName: 'Pro',
        mrrCents: 2900,
        tenureDays: 120,
        cancelledAt: new Date(),
        status: 'recovered',
        source: TAG,
      })
      .returning({ id: churnedSubscribers.id })
    subscriberId = inserted.id
  }

  const [rec] = await db
    .insert(recoveries)
    .values({
      subscriberId,
      customerId: customer.id,
      recoveredAt: new Date(),
      planMrrCents: 2900,
      attributionType: 'strong',
      recoveryType: 'win_back',
      perfFeeChargedAt: new Date(),
      perfFeeStripeItemId: item.id,
      perfFeeAmountCents: 2900,
    })
    .returning({ id: recoveries.id })

  appendMarker(rec.id)
  console.log(`  · seeded recovery row: ${rec.id}`)
  console.log('\n→ Open http://localhost:3000/admin/billing')
  console.log('  - "Charged win-back fees" section shows the new row, status: Charged · within 14d')
  console.log('  - "View in Stripe ↗" opens the real invoice item page in the test dashboard')
  console.log('  - Click Refund → modal → type REFUND → confirm')
  console.log('  - Expected: row flips to Refunded; Stripe creates a credit note + real refund;')
  console.log('    refund appears on Stripe Dashboard → Payments (negative amount)')
  console.log('  - /admin/audit-log records the perf_fee_refunded admin_action event with method=credit_note')
  console.log('\n  When done: npx tsx --env-file=.env.local scripts/smoke-spec67-seed.ts cleanup')
}

async function cleanup() {
  const markers = readMarkers()
  if (markers.length === 0) {
    console.log('No marker file — nothing to clean up.')
    return
  }
  const stripe = getPlatformStripe()

  const recs = await db
    .select({ id: recoveries.id, item: recoveries.perfFeeStripeItemId, subscriberId: recoveries.subscriberId })
    .from(recoveries)
    .where(inArray(recoveries.id, markers))

  for (const r of recs) {
    if (r.item) {
      try {
        await stripe.invoiceItems.del(r.item)
        console.log(`  · deleted Stripe item: ${r.item}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('No such') || msg.includes('already')) {
          console.log(`  · Stripe item already gone: ${r.item}`)
        } else {
          console.log(`  · could not delete Stripe item ${r.item}: ${msg}`)
        }
      }
    }
    await db.delete(recoveries).where(eq(recoveries.id, r.id))
  }

  // Drop any smoke-only subscribers (created when no existing one was reused)
  const subs = await db
    .delete(churnedSubscribers)
    .where(eq(churnedSubscribers.source, TAG))
    .returning({ id: churnedSubscribers.id })

  clearMarkers()
  console.log(`Cleaned up ${recs.length} recovery row(s), ${subs.length} subscriber row(s)`)
}

const cmd = process.argv[2]
const fn = cmd === 'seed' ? seed : cmd === 'cleanup' ? cleanup : null
if (!fn) {
  console.error('Usage: smoke-spec67-seed.ts seed|cleanup')
  process.exit(1)
}
fn().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

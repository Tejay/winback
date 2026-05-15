// Spec 77 — end-to-end test for per-customer custom flat-rate billing.
//
//   npx tsx --env-file=.env.local scripts/spec77-flat-rate-e2e.ts
//
// Verifies the full real-Stripe round-trip:
//   1. Resets tejaasvi@gmail.com to a clean baseline (no platform sub).
//   2. Creates a fresh platform Stripe customer + pm_card_visa default,
//      runs ensureActivation → standard $99/mo Stripe Subscription lands.
//   3. Snapshots pre-switch state: sub ID, current Price ID + unit_amount,
//      and the AMOUNT THE CUSTOMER WILL BE BILLED NEXT MONTH via
//      stripe.invoices.createPreview().
//   4. Calls switchCustomerToFlatRate(customerId, 29900) — the new Spec 77
//      lib helper. This is what the admin endpoint calls under the hood.
//   5. Re-snapshots post-switch state and verifies:
//        - DB customMonthlyCents = 29900
//        - Stripe sub's price item now points at a custom Price
//          with unit_amount = 29900
//        - Upcoming invoice for the sub is $299.00 (THE KEY CHECK —
//          this is what the customer will actually pay next cycle)
//   6. Seeds a fake recovery + calls chargePerformanceFee →
//      verifies it returns {skipped: 'flat_rate'} without touching Stripe.
//   7. Calls revertCustomerToStandardRate → verifies $99 is restored,
//      upcoming invoice back to $99.00.
//
// Uses real Stripe TEST MODE on the tkedambadi@gmail.com platform
// account (sk_test_… in .env.local). Free.

import { db } from '../lib/db'
import {
  customers,
  churnedSubscribers,
  recoveries,
  users,
  wbEvents,
  emailsSent,
} from '../lib/schema'
import { eq, and, inArray } from 'drizzle-orm'
import Stripe from 'stripe'
import { ensureActivation } from '../src/winback/lib/activation'
import {
  switchCustomerToFlatRate,
  revertCustomerToStandardRate,
} from '../src/winback/lib/subscription'
import { chargePerformanceFee } from '../src/winback/lib/performance-fee'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const TEST_FLAT_RATE_CENTS = 29900  // $299/mo
const PERF_FEE_MRR_CENTS = 4900    // $49 mrr × 1 = $49 perf fee

interface Verdict { name: string; pass: boolean; detail?: string }
const verdicts: Verdict[] = []

function check(name: string, pass: boolean, detail?: string) {
  verdicts.push({ name, pass, detail })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const platform = new Stripe(process.env.STRIPE_SECRET_KEY!)

  // ────────────────────────────────────────────────────────────────────
  // 0) Resolve dev founder + clean baseline
  // ────────────────────────────────────────────────────────────────────
  console.log('Spec 77 — flat-rate billing live E2E\n')
  console.log('[0/7] Resolve + clean slate')

  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  if (!u) { console.error(`user ${TARGET_EMAIL} not found`); process.exit(1) }
  const [c] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) { console.error(`customer for ${TARGET_EMAIL} not found`); process.exit(1) }
  console.log(`  founder=${TARGET_EMAIL}  customerId=${c.id}`)

  // Cancel any pre-existing platform subs for this email so we start fresh.
  const platformCustomers = new Set<string>()
  if (c.stripePlatformCustomerId) platformCustomers.add(c.stripePlatformCustomerId)
  const byEmail = await platform.customers.list({ email: TARGET_EMAIL, limit: 20 })
  for (const pc of byEmail.data) platformCustomers.add(pc.id)
  for (const pcId of platformCustomers) {
    const subs = await platform.subscriptions.list({ customer: pcId, status: 'all', limit: 20 })
    for (const s of subs.data) {
      if (s.status === 'active' || s.status === 'trialing' || s.status === 'past_due') {
        await platform.subscriptions.cancel(s.id)
        console.log(`  cancelled stray sub ${s.id} on ${pcId}`)
      }
    }
  }

  // Reset customer columns + delete any leftover spec77 test rows. Also
  // clear pilotUntil for the duration of this test (otherwise ensureActivation
  // returns state=pilot and skips creating the $99 platform sub, which is
  // what we're trying to swap). Saved pilotUntil is restored at the end.
  const [snapshot] = await db.select({ pilotUntil: customers.pilotUntil })
    .from(customers).where(eq(customers.id, c.id)).limit(1)
  const savedPilotUntil = snapshot?.pilotUntil ?? null

  await db.update(customers)
    .set({
      stripeSubscriptionId: null,
      stripeSubscriptionCreatingAt: null,
      stripePlatformCustomerId: null,
      activatedAt: null,
      customMonthlyCents: null,
      pilotUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, c.id))

  // Delete spec77 test recoveries + their subscribers.
  const existingSubs = await db.select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(and(eq(churnedSubscribers.customerId, c.id), eq(churnedSubscribers.source, 'spec77-e2e')))
  if (existingSubs.length > 0) {
    const ids = existingSubs.map((s) => s.id)
    await db.delete(recoveries).where(inArray(recoveries.subscriberId, ids))
    await db.delete(churnedSubscribers).where(inArray(churnedSubscribers.id, ids))
    console.log(`  deleted ${existingSubs.length} prior spec77-e2e row(s)`)
  }
  console.log('  ✓ baseline clean')

  // ────────────────────────────────────────────────────────────────────
  // 1) Seed a recovery row (needed for perf-fee bypass test in step 6)
  // ────────────────────────────────────────────────────────────────────
  console.log('\n[1/7] Seed a churned subscriber + a recovery (for the perf-fee bypass check later)')
  const [seedSub] = await db.insert(churnedSubscribers).values({
    customerId:       c.id,
    stripeCustomerId: `cus_spec77_${Date.now()}`,
    email:            'spec77-e2e-sub@example.com',
    name:             'Spec77 E2E',
    planName:         'Pro',
    mrrCents:         PERF_FEE_MRR_CENTS,
    cancelledAt:      new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    status:           'recovered',
    source:           'spec77-e2e',
  }).returning()

  const [seedRec] = await db.insert(recoveries).values({
    subscriberId:     seedSub.id,
    customerId:       c.id,
    planMrrCents:     PERF_FEE_MRR_CENTS,
    recoveryType:     'win_back',
    attributionType:  'strong',
  }).returning()
  console.log(`  ✓ subscriber=${seedSub.id}  recovery=${seedRec.id}`)

  // ────────────────────────────────────────────────────────────────────
  // 2) Create platform Stripe customer + attach pm_card_visa
  // ────────────────────────────────────────────────────────────────────
  console.log('\n[2/7] Create platform customer + attach pm_card_visa as default')
  const platformCustomer = await platform.customers.create({
    email: `spec77-${Date.now()}@example.com`,
    name:  'Spec 77 E2E',
    metadata: { winback_customer_id: c.id, test: 'spec77-e2e' },
  })
  const pm = await platform.paymentMethods.attach('pm_card_visa', { customer: platformCustomer.id })
  await platform.customers.update(platformCustomer.id, {
    invoice_settings: { default_payment_method: pm.id },
  })
  await db.update(customers)
    .set({ stripePlatformCustomerId: platformCustomer.id, updatedAt: new Date() })
    .where(eq(customers.id, c.id))
  console.log(`  ✓ platform=${platformCustomer.id}  PM=${pm.id}`)

  // ────────────────────────────────────────────────────────────────────
  // 3) Land the standard $99/mo subscription via ensureActivation
  // ────────────────────────────────────────────────────────────────────
  console.log('\n[3/7] ensureActivation → standard $99/mo subscription')
  const activation = await ensureActivation(c.id)
  if (activation.state !== 'active') {
    console.error(`Activation failed: state=${activation.state}`)
    process.exit(1)
  }
  console.log(`  ✓ subId=${activation.subscriptionId}  state=active`)

  // ────────────────────────────────────────────────────────────────────
  // 4) Snapshot pre-switch state — what would they pay next month?
  // ────────────────────────────────────────────────────────────────────
  console.log('\n[4/7] Pre-switch snapshot')
  const subBefore = await platform.subscriptions.retrieve(activation.subscriptionId)
  const priceBefore = subBefore.items.data[0]?.price
  const upcomingBefore = await platform.invoices.createPreview({ subscription: activation.subscriptionId })
  console.log(`  Stripe sub item Price.unit_amount = ${priceBefore?.unit_amount} (= $${((priceBefore?.unit_amount ?? 0) / 100).toFixed(2)})`)
  console.log(`  Stripe upcoming invoice total     = ${upcomingBefore.amount_due} cents (= $${(upcomingBefore.amount_due / 100).toFixed(2)})`)
  console.log(`  Stripe upcoming invoice period    = ${new Date(upcomingBefore.period_start * 1000).toISOString().slice(0, 10)} → ${new Date(upcomingBefore.period_end * 1000).toISOString().slice(0, 10)}`)
  check('pre: Price.unit_amount = 9900', priceBefore?.unit_amount === 9900)
  check('pre: upcoming invoice amount_due = 9900', upcomingBefore.amount_due === 9900)

  // ────────────────────────────────────────────────────────────────────
  // 5) Apply flat-rate $299 via the Spec 77 lib helper
  // ────────────────────────────────────────────────────────────────────
  console.log('\n[5/7] switchCustomerToFlatRate(customerId, 29900)')
  const switchResult = await switchCustomerToFlatRate(c.id, TEST_FLAT_RATE_CENTS, { adminEmail: 'spec77-e2e@local' })
  console.log(`  Lib reported priceUpdated=${switchResult.priceUpdated}`)

  // Re-fetch DB to confirm the column.
  const [cAfterSwitch] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  check('DB customMonthlyCents = 29900', cAfterSwitch.customMonthlyCents === 29900,
    `actual=${cAfterSwitch.customMonthlyCents}`)

  // Re-fetch Stripe sub to confirm the Price swap.
  const subAfter = await platform.subscriptions.retrieve(activation.subscriptionId)
  const priceAfter = subAfter.items.data[0]?.price
  console.log(`  Stripe sub item Price.unit_amount = ${priceAfter?.unit_amount} (= $${((priceAfter?.unit_amount ?? 0) / 100).toFixed(2)})`)
  check('Stripe Price.unit_amount = 29900', priceAfter?.unit_amount === TEST_FLAT_RATE_CENTS,
    `actual=${priceAfter?.unit_amount}`)
  check('Price metadata.winback_role = custom_flat_rate',
    priceAfter?.metadata?.winback_role === 'custom_flat_rate',
    `actual=${priceAfter?.metadata?.winback_role}`)

  // THE KEY CHECK — what will they ACTUALLY be billed next month?
  const upcomingAfter = await platform.invoices.createPreview({ subscription: activation.subscriptionId })
  console.log(`  Stripe upcoming invoice total     = ${upcomingAfter.amount_due} cents (= $${(upcomingAfter.amount_due / 100).toFixed(2)})`)
  console.log(`  Stripe upcoming invoice period    = ${new Date(upcomingAfter.period_start * 1000).toISOString().slice(0, 10)} → ${new Date(upcomingAfter.period_end * 1000).toISOString().slice(0, 10)}`)
  check('upcoming invoice amount_due = 29900 (= $299/mo)',
    upcomingAfter.amount_due === TEST_FLAT_RATE_CENTS,
    `actual=${upcomingAfter.amount_due} cents`)

  // Audit trail.
  const [auditAssigned] = await db.select().from(wbEvents)
    .where(and(eq(wbEvents.customerId, c.id), eq(wbEvents.name, 'flat_rate_assigned')))
    .limit(1)
  check('flat_rate_assigned event logged', !!auditAssigned,
    auditAssigned ? `properties=${JSON.stringify(auditAssigned.properties)}` : 'missing')

  // ────────────────────────────────────────────────────────────────────
  // 6) Perf-fee bypass: chargePerformanceFee should skip with flat_rate
  // ────────────────────────────────────────────────────────────────────
  console.log('\n[6/7] chargePerformanceFee on flat-rate customer → expect skipped:flat_rate')
  // The seed recovery already had its perf fee charged during step 3's
  // ensureActivation (which runs chargePendingPerformanceFees for any
  // recovery with perfFeeStripeItemId IS NULL). Reset it so the bypass
  // gate actually fires this time around.
  await db.update(recoveries)
    .set({ perfFeeStripeItemId: null, perfFeeAmountCents: null, perfFeeChargedAt: null })
    .where(eq(recoveries.id, seedRec.id))

  const perfResult = await chargePerformanceFee(seedRec.id)
  console.log(`  Result: ${JSON.stringify(perfResult)}`)
  check('perf fee skipped with reason=flat_rate', perfResult.skipped === 'flat_rate')
  check('no Stripe invoiceItem created', perfResult.invoiceItemId === null)
  check('recovery row not marked charged', perfResult.alreadyCharged === false)

  // Confirm no Stripe invoice item was actually added.
  const subItemsAfterPerf = await platform.subscriptions.retrieve(activation.subscriptionId)
  const upcomingAfterPerf = await platform.invoices.createPreview({ subscription: activation.subscriptionId })
  check('upcoming invoice STILL $299 (no perf fee added)',
    upcomingAfterPerf.amount_due === TEST_FLAT_RATE_CENTS,
    `actual=${upcomingAfterPerf.amount_due}`)

  // ────────────────────────────────────────────────────────────────────
  // 7) Revert to standard → $99 restored
  // ────────────────────────────────────────────────────────────────────
  console.log('\n[7/7] revertCustomerToStandardRate → standard $99 restored')
  const revertResult = await revertCustomerToStandardRate(c.id, { adminEmail: 'spec77-e2e@local' })
  console.log(`  Lib reported priceUpdated=${revertResult.priceUpdated}`)

  const [cAfterRevert] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  check('DB customMonthlyCents cleared (null)', cAfterRevert.customMonthlyCents === null,
    `actual=${cAfterRevert.customMonthlyCents}`)

  const subFinal = await platform.subscriptions.retrieve(activation.subscriptionId)
  const priceFinal = subFinal.items.data[0]?.price
  console.log(`  Stripe sub item Price.unit_amount = ${priceFinal?.unit_amount} (= $${((priceFinal?.unit_amount ?? 0) / 100).toFixed(2)})`)
  check('Stripe Price.unit_amount back to 9900', priceFinal?.unit_amount === 9900,
    `actual=${priceFinal?.unit_amount}`)

  const upcomingFinal = await platform.invoices.createPreview({ subscription: activation.subscriptionId })
  console.log(`  Stripe upcoming invoice total     = ${upcomingFinal.amount_due} cents (= $${(upcomingFinal.amount_due / 100).toFixed(2)})`)
  check('upcoming invoice back to 9900', upcomingFinal.amount_due === 9900,
    `actual=${upcomingFinal.amount_due}`)

  const [auditCleared] = await db.select().from(wbEvents)
    .where(and(eq(wbEvents.customerId, c.id), eq(wbEvents.name, 'flat_rate_cleared')))
    .limit(1)
  check('flat_rate_cleared event logged', !!auditCleared)

  // ────────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────────
  console.log('\n── SUMMARY ─────────────────────────────────')
  const pass = verdicts.filter((v) => v.pass).length
  const fail = verdicts.filter((v) => !v.pass).length
  console.log(`  ${pass} passed, ${fail} failed of ${verdicts.length} checks`)
  if (fail > 0) {
    console.log('\n  Failing checks:')
    for (const v of verdicts.filter((x) => !x.pass)) {
      console.log(`    ✗ ${v.name}${v.detail ? ` — ${v.detail}` : ''}`)
    }
    process.exit(1)
  }
  // Restore pilotUntil if the customer was on pilot before the test.
  if (savedPilotUntil) {
    await db.update(customers)
      .set({ pilotUntil: savedPilotUntil, updatedAt: new Date() })
      .where(eq(customers.id, c.id))
    console.log(`  Restored pilotUntil to ${savedPilotUntil.toISOString()}`)
  }

  console.log('\n  All green. Flat-rate billing works end-to-end on real Stripe test mode.')
  console.log(`  Final state: customer is back on standard $99/mo via sub ${activation.subscriptionId}.`)
}

main().catch((e) => { console.error('E2E FAILED:', e); process.exit(1) })

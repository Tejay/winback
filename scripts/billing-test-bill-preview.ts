// End-of-cycle bill preview — what will the merchant be charged at the
// next renewal of the $99/mo platform subscription?
//
// Seeds (in addition to whatever is already in the DB):
//   - 10 card_save (payment recovery) wb_recoveries — should NOT bill
//   - 4 win_back wb_recoveries, each with a real Stripe invoice item
//     attached to the platform subscription
//
// Then retrieves Stripe's upcoming/preview invoice for tejaasvi's
// platform subscription and prints the full line-item breakdown.
// Pre-existing data is untouched.
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-bill-preview.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent, users } from '../lib/schema'
import { eq } from 'drizzle-orm'
import Stripe from 'stripe'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const NUM_CARD_SAVE = 10
const NUM_WINBACK = 4
const PLAN_MRR_CENTS = 5000 // $50/mo per subscriber
const PERF_FEE_CENTS = 5000 // 1× MRR

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c) { console.error('customer not found'); process.exit(1) }
  if (!c.stripeSubscriptionId || !c.stripePlatformCustomerId) {
    console.error(`Customer not subscribed yet. subId=${c.stripeSubscriptionId}  platformCustomer=${c.stripePlatformCustomerId}`)
    console.error('Run Tier 1.2 first (click Subscribe).')
    process.exit(1)
  }

  const platform = new Stripe(process.env.STRIPE_SECRET_KEY!)

  console.log(`Target: ${TARGET_EMAIL}  customerId=${c.id}`)
  console.log(`Platform Stripe: customer=${c.stripePlatformCustomerId}  sub=${c.stripeSubscriptionId}\n`)

  // Snapshot pre-state for context
  const preRecs = await db.select().from(recoveries).where(eq(recoveries.customerId, c.id))
  const cardSaveBefore = preRecs.filter(r => r.recoveryType === 'card_save').length
  const winBackBefore = preRecs.filter(r => r.recoveryType === 'win_back').length
  console.log(`Pre-seed recoveries: ${preRecs.length}  (card_save=${cardSaveBefore}, win_back=${winBackBefore})\n`)

  // 1) Seed 10 card_save recoveries (no Stripe side-effects)
  console.log(`[1/3] Seeding ${NUM_CARD_SAVE} card_save recoveries (no perf fee)`)
  for (let i = 0; i < NUM_CARD_SAVE; i++) {
    const tag = `dunning-${Date.now()}-${i}`
    const [sub] = await db.insert(churnedSubscribers).values({
      customerId: c.id,
      stripeCustomerId: `cus_FAKE_DUNNING_${i}_${Date.now()}`,
      name: `Dunning Subscriber ${i + 1}`,
      email: `${tag}@example.com`,
      cancellationReason: 'Payment failed',
      dunningState: 'recovered_during_dunning',
      mrrCents: PLAN_MRR_CENTS,
      status: 'recovered',
      paymentMethodAtFailure: 'pm_FAKE',
      billingPortalClickedAt: new Date(),
    }).returning({ id: churnedSubscribers.id })
    await db.insert(recoveries).values({
      subscriberId: sub.id,
      customerId: c.id,
      planMrrCents: PLAN_MRR_CENTS,
      recoveryType: 'card_save',
      attributionType: 'strong',
      // perfFee* explicitly NOT set
    })
  }
  console.log(`    ✓ ${NUM_CARD_SAVE} card_save recoveries seeded\n`)

  // 2) Seed 4 win_back recoveries + create Stripe invoice items on the platform sub
  console.log(`[2/3] Seeding ${NUM_WINBACK} win_back recoveries (each $${(PERF_FEE_CENTS / 100).toFixed(2)} perf fee → Stripe invoice item)`)
  for (let i = 0; i < NUM_WINBACK; i++) {
    const subscriberName = `Winback Subscriber ${i + 1}`
    const tag = `winback-${Date.now()}-${i}`
    const [sub] = await db.insert(churnedSubscribers).values({
      customerId: c.id,
      stripeCustomerId: `cus_FAKE_WINBACK_${i}_${Date.now()}`,
      name: subscriberName,
      email: `${tag}@example.com`,
      cancellationReason: 'Lost interest',
      mrrCents: PLAN_MRR_CENTS,
      status: 'recovered',
    }).returning({ id: churnedSubscribers.id })
    // Email + reply so attribution makes sense for audit
    await db.insert(emailsSent).values({
      subscriberId: sub.id,
      type: 'exit',
      subject: '(seed) synthetic exit email',
      bodyText: '(seed)',
      sentAt: new Date(Date.now() - 24 * 3600 * 1000),
      repliedAt: new Date(Date.now() - 12 * 3600 * 1000),
    })
    // Create the real Stripe invoice item against the platform sub — this is
    // what production's chargePerformanceFee would do.
    const ii = await platform.invoiceItems.create({
      customer: c.stripePlatformCustomerId!,
      amount: PERF_FEE_CENTS,
      currency: 'usd',
      description: `Winback recovery — ${subscriberName} ($${(PLAN_MRR_CENTS / 100).toFixed(2)}/mo)`,
      subscription: c.stripeSubscriptionId!,
    })
    await db.insert(recoveries).values({
      subscriberId: sub.id,
      customerId: c.id,
      planMrrCents: PLAN_MRR_CENTS,
      recoveryType: 'win_back',
      attributionType: 'strong',
      perfFeeStripeItemId: ii.id,
      perfFeeChargedAt: new Date(),
      perfFeeAmountCents: PERF_FEE_CENTS,
    })
    console.log(`    ${i + 1}/${NUM_WINBACK} ${subscriberName} → invoice item ${ii.id}`)
  }
  console.log()

  // 3) Retrieve the upcoming/preview invoice
  console.log(`[3/3] Stripe upcoming invoice for platform sub ${c.stripeSubscriptionId}`)
  let upcoming: Stripe.Invoice
  try {
    // Newer SDK: stripe.invoices.createPreview
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upcoming = await (platform.invoices as any).createPreview({
      customer: c.stripePlatformCustomerId,
      subscription: c.stripeSubscriptionId,
    })
  } catch (e) {
    // Legacy SDK path
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upcoming = await (platform.invoices as any).retrieveUpcoming({
      customer: c.stripePlatformCustomerId,
      subscription: c.stripeSubscriptionId,
    })
  }

  console.log()
  console.log('=== UPCOMING INVOICE ===')
  console.log(`  Period:   ${new Date((upcoming.period_start ?? 0) * 1000).toISOString()} → ${new Date((upcoming.period_end ?? 0) * 1000).toISOString()}`)
  console.log(`  Subtotal: $${(upcoming.subtotal / 100).toFixed(2)}`)
  console.log(`  Total:    $${(upcoming.total / 100).toFixed(2)}`)
  console.log(`  Currency: ${upcoming.currency}`)
  console.log()
  console.log('  Line items:')
  for (const line of upcoming.lines.data) {
    const amount = (line.amount / 100).toFixed(2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const type = (line as any).type ?? (line as any).object
    console.log(`    $${amount}  [${type}]  ${line.description ?? '(no description)'}`)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

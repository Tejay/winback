// Tier 2.1 — Race-fence: parallel ensureActivation.
//
// Sets up the exact pre-state that exists between Checkout completing
// and ensureActivation running (post-recovery, activatedAt set, platform
// customer + default PM attached, no subscription yet, no pending lock).
// Then fires N concurrent ensureActivation calls and checks that:
//   - exactly one Stripe subscription was created
//   - exactly one perf fee item was charged per pending win-back
//   - the DB lock (stripe_subscription_creating_at) is released
//   - all N call-results agree on the same subscription id
//   - only one caller reports `subscriptionCreated=true`
//
// If the race-fence ever leaks, this test catches it: we'd see N
// subscriptions on the platform customer or N copies of the perf fee item.
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier2-race-fence.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent, users, wbEvents } from '../lib/schema'
import { eq, and } from 'drizzle-orm'
import { ensureActivation, type ActivationState } from '../src/winback/lib/activation'
import Stripe from 'stripe'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const N_PARALLEL = 5
const PERF_FEE_MRR_CENTS = 5000

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c) { console.error('customer not found'); process.exit(1) }

  if (c.stripeSubscriptionId || c.stripeSubscriptionCreatingAt) {
    console.error(`Customer NOT clean. subId=${c.stripeSubscriptionId}  creatingAt=${c.stripeSubscriptionCreatingAt}`)
    console.error('Run scripts/billing-test-reset.ts first.')
    process.exit(1)
  }

  console.log(`Target: ${TARGET_EMAIL}  customerId=${c.id}`)
  console.log(`N parallel ensureActivation calls = ${N_PARALLEL}\n`)

  const platform = new Stripe(process.env.STRIPE_SECRET_KEY!)

  // 1) Set up pre-state synthetically: subscriber + win-back recovery + emails,
  // so chargePendingPerformanceFees has one item to charge during activation.
  console.log('[1/4] Seed wb_churned_subscribers + win-back wb_recoveries')
  const [seedSub] = await db.insert(churnedSubscribers).values({
    customerId: c.id,
    stripeCustomerId: `cus_TIER2_FAKE_${Date.now()}`,
    name: 'Tier 2 Race Subscriber',
    email: `tier2-race-${Date.now()}@example.com`,
    cancellationReason: 'Lost interest',
    mrrCents: PERF_FEE_MRR_CENTS,
    status: 'recovered',
  }).returning({ id: churnedSubscribers.id })
  await db.insert(emailsSent).values({
    subscriberId: seedSub.id,
    type: 'exit',
    subject: '(tier 2) synthetic',
    bodyText: '(tier 2)',
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
  console.log(`    subscriber=${seedSub.id}  recovery seeded (perf fee will be queued by activation)`)

  // 2) Create platform Stripe customer + attach card directly (skip Checkout)
  console.log('[2/4] Create platform Stripe customer + attach pm_card_visa as default')
  const platformCustomer = await platform.customers.create({
    email: `tier2-race-${Date.now()}@example.com`,
    name: 'Tier 2 platform test',
    metadata: { winback_customer_id: c.id, tier: '2.1' },
  })
  const pm = await platform.paymentMethods.attach('pm_card_visa', { customer: platformCustomer.id })
  await platform.customers.update(platformCustomer.id, {
    invoice_settings: { default_payment_method: pm.id },
  })
  await db.update(customers)
    .set({ stripePlatformCustomerId: platformCustomer.id, updatedAt: new Date() })
    .where(eq(customers.id, c.id))
  console.log(`    platform=${platformCustomer.id}  PM=${pm.id}`)

  // 3) Fire N parallel ensureActivation calls
  console.log(`\n[3/4] Firing ${N_PARALLEL} concurrent ensureActivation(${c.id}) calls`)
  const t0 = Date.now()
  const settled = await Promise.allSettled(
    Array.from({ length: N_PARALLEL }, () => ensureActivation(c.id))
  )
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2)
  console.log(`    all ${N_PARALLEL} calls settled in ${elapsed}s`)

  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]
    if (r.status === 'rejected') {
      console.log(`    #${i + 1}: REJECTED — ${r.reason instanceof Error ? r.reason.message : r.reason}`)
    } else {
      const v = r.value as ActivationState
      const summary = v.state === 'active'
        ? `state=active  subId=${v.subscriptionId}  subCreated=${v.subscriptionCreated}  chargedRecs=${v.chargedRecoveryIds.length}`
        : `state=${v.state}`
      console.log(`    #${i + 1}: ${summary}`)
    }
  }

  // 4) Verify
  console.log('\n[4/4] Verify race-fence held')

  // DB state
  const [after] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  console.log(`  DB customer:`)
  console.log(`    stripeSubscriptionId=${after.stripeSubscriptionId}`)
  console.log(`    stripeSubscriptionCreatingAt=${after.stripeSubscriptionCreatingAt?.toISOString() ?? 'NULL ✓ (lock released)'}`)

  // Stripe — how many active subscriptions on this platform customer?
  const subs = await platform.subscriptions.list({ customer: platformCustomer.id, status: 'all', limit: 10 })
  console.log(`\n  Stripe subscriptions on ${platformCustomer.id}: ${subs.data.length}`)
  for (const s of subs.data) {
    console.log(`    ${s.id}  status=${s.status}  created=${new Date(s.created * 1000).toISOString()}`)
  }
  const oneSubOk = subs.data.length === 1
  console.log(`  → ${oneSubOk ? '✓ EXACTLY ONE subscription created (race-fence held)' : '❌ FAIL: multiple subscriptions created'}`)

  // Stripe — how many invoice items for the perf fee?
  // The real description is `Win-back: ${email}`; filter on that prefix.
  const items = await platform.invoiceItems.list({ customer: platformCustomer.id, limit: 50 })
  const perfItems = items.data.filter(i => (i.description ?? '').startsWith('Win-back:'))
  console.log(`\n  Stripe invoice items on ${platformCustomer.id}: ${items.data.length} total, ${perfItems.length} perf-fee`)
  for (const it of perfItems) {
    console.log(`    ${it.id}  amount=${it.amount}  description=${it.description}`)
  }
  // We seeded ONE win-back recovery. Without Spec 58 we saw 5-8 items. With
  // the fix, we expect exactly 1.
  const oneFeeOk = perfItems.length === 1
  console.log(`  → ${oneFeeOk ? '✓ EXACTLY ONE perf fee item (Spec 58 race-fence held)' : '❌ FAIL: duplicate perf fee items'}`)

  // wb_events — count Spec 58 race-skip events. There should be at least one
  // (the perf-fee lock-losers log this); the subscription race uses throw,
  // not an event, so no platform_subscription_* event count.
  const skipEvents = await db
    .select({ name: wbEvents.name })
    .from(wbEvents)
    .where(and(
      eq(wbEvents.customerId, c.id),
      eq(wbEvents.name, 'perf_fee_create_skipped_race'),
    ))
  console.log(`\n  wb_events 'perf_fee_create_skipped_race': ${skipEvents.length}`)
  console.log(`  → expected ≥ 1 (at least one perf-fee claim lost the race)`)

  // Agreement among return values
  const activeResults = settled
    .filter((r): r is PromiseFulfilledResult<ActivationState> => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(v => v.state === 'active') as Array<Extract<ActivationState, { state: 'active' }>>
  const uniqueSubIds = new Set(activeResults.map(r => r.subscriptionId))
  const oneCreatedTrue = activeResults.filter(r => r.subscriptionCreated).length
  console.log(`\n  Caller return-value agreement:`)
  console.log(`    unique subscriptionIds returned: ${uniqueSubIds.size}  ${uniqueSubIds.size === 1 ? '✓' : '❌'}`)
  console.log(`    callers with subscriptionCreated=true: ${oneCreatedTrue}  ${oneCreatedTrue === 1 ? '✓' : '❌'}`)
  console.log(`    callers with subscriptionCreated=false: ${activeResults.length - oneCreatedTrue}  (expected ${N_PARALLEL - 1})`)

  // Some lock-losers throw (subscription race) rather than returning state=active
  // with subscriptionCreated=false. Either is acceptable — the invariant is that
  // exactly one subscription was created.
  console.log('\n=== Verdict ===')
  if (oneSubOk && oneFeeOk && uniqueSubIds.size <= 1 && oneCreatedTrue === 1) {
    console.log('✓✓✓ Both race-fences held under concurrent calls.')
  } else {
    console.log('❌ FAILURE — at least one race-fence leaked, see details above.')
    process.exit(1)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

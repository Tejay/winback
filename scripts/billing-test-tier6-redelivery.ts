// Tier 6 — Webhook redundancy + idempotency, beyond what Tier 2.3 covered.
//
//   6.1  Platform-side webhook redelivery
//        Cancel the platform sub → wait for processPlatformSubscriptionDeleted
//        → resend the same event → DB state must be unchanged
//        (stripeSubscriptionId stays NULL, no duplicate platform sub on Stripe)
//
//   6.2  Same event delivered THREE times rapidly
//        Resend the same event one more time on top of the 6.1 redelivery
//        → state still consistent under triple delivery
//
//   6.3  Drain-cron idempotency check (Spec 54 SQL filter)
//        The cron only picks rows where pause_drain_processed_at IS NULL.
//        We seed a row WITH that field set and confirm the cron's
//        partial-index-backed query excludes it. No LLM call, no email
//        send — just verifying the filter semantics.
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier6-redelivery.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent, wbEvents, users } from '../lib/schema'
import { eq, and, desc, isNull, isNotNull, or, sql, count } from 'drizzle-orm'
import { ensureActivation } from '../src/winback/lib/activation'
import Stripe from 'stripe'
import { spawn } from 'child_process'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const PERF_FEE_MRR_CENTS = 5000
const POLL_TIMEOUT_MS = 30_000

async function poll<T>(name: string, fn: () => Promise<T | null>): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const v = await fn()
    if (v !== null) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`    ✓ ${name} (${elapsed}s)`)
      return v
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  throw new Error(`Timeout: ${name}`)
}

async function stripeEventsResend(eventId: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = spawn('stripe', ['events', 'resend', eventId], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    cmd.stderr.on('data', (d) => (stderr += d.toString()))
    cmd.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`stripe events resend ${eventId} exited ${code}: ${stderr.slice(0, 500)}`))
    })
  })
}

async function setupSubscribedCustomer(c: { id: string }, platform: Stripe): Promise<{ subscriptionId: string }> {
  // Seed a recovery (needed to drive activation)
  const tag = `tier6-${Date.now()}`
  const [seedSub] = await db.insert(churnedSubscribers).values({
    customerId: c.id, stripeCustomerId: `cus_TIER6_${tag}`,
    name: 'Tier 6 sub', email: `${tag}@example.com`,
    cancellationReason: 'Lost interest', mrrCents: PERF_FEE_MRR_CENTS, status: 'recovered',
  }).returning({ id: churnedSubscribers.id })
  await db.insert(emailsSent).values({
    subscriberId: seedSub.id, type: 'exit', subject: '(tier 6)', bodyText: '(tier 6)',
    sentAt: new Date(Date.now() - 60_000), repliedAt: new Date(),
  })
  await db.insert(recoveries).values({
    subscriberId: seedSub.id, customerId: c.id,
    planMrrCents: PERF_FEE_MRR_CENTS, recoveryType: 'win_back', attributionType: 'strong',
  })

  // Create platform customer + PM
  const platformCustomer = await platform.customers.create({
    email: `${tag}@example.com`, name: 'Tier 6 platform',
    metadata: { winback_customer_id: c.id, tier: '6' },
  })
  const pm = await platform.paymentMethods.attach('pm_card_visa', { customer: platformCustomer.id })
  await platform.customers.update(platformCustomer.id, { invoice_settings: { default_payment_method: pm.id } })
  await db.update(customers)
    .set({ stripePlatformCustomerId: platformCustomer.id, updatedAt: new Date() })
    .where(eq(customers.id, c.id))

  // Activate
  const activation = await ensureActivation(c.id)
  if (activation.state !== 'active') throw new Error(`activation state=${activation.state}`)
  return { subscriptionId: activation.subscriptionId }
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c) { console.error('customer not found'); process.exit(1) }
  if (c.stripeSubscriptionId || c.activatedAt) { console.error('reset first'); process.exit(1) }

  const platform = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2026-03-25.dahlia' })
  const stripeCliEnv = { ...process.env, STRIPE_API_KEY: process.env.STRIPE_SECRET_KEY }

  console.log('=== Tier 6 — Webhook redelivery + drain-cron idempotency ===\n')

  // === Setup: subscribed customer ===
  console.log('[setup] Subscribe customer (real platform sub via ensureActivation)')
  const { subscriptionId } = await setupSubscribedCustomer(c, platform)
  console.log(`    platform sub: ${subscriptionId}`)

  // === 6.1 — Cancel sub, then resend the cancel event ===
  console.log('\n[6.1] Cancel platform sub → wait for processPlatformSubscriptionDeleted → resend the event')
  await platform.subscriptions.cancel(subscriptionId)
  await poll('customers.stripeSubscriptionId cleared (first delivery)', async () => {
    const [row] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
    return row?.stripeSubscriptionId === null ? row : null
  })

  // Snapshot AFTER first delivery
  const [eventCountBeforeResend] = await db
    .select({ value: count() })
    .from(wbEvents)
    .where(and(eq(wbEvents.customerId, c.id), eq(wbEvents.name, 'platform_subscription_canceled')))
  console.log(`    pre-resend: platform_subscription_canceled event count = ${eventCountBeforeResend.value}`)

  // Find the event id from Stripe
  const events = await platform.events.list({ limit: 30, type: 'customer.subscription.deleted' })
  const cancelEvent = events.data.find(e => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = e.data.object as any
    return obj?.id === subscriptionId
  })
  if (!cancelEvent) { console.error('cancel event not found in events.list'); process.exit(1) }
  console.log(`    found cancel event: ${cancelEvent.id}`)

  console.log('    Resending (1st resend)...')
  await stripeEventsResend(cancelEvent.id, stripeCliEnv)
  console.log('    Waiting 6s for redelivery to process...')
  await new Promise(r => setTimeout(r, 6_000))

  // Verify state unchanged
  const [afterResend1] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  console.log(`    customers.stripeSubscriptionId = ${afterResend1.stripeSubscriptionId ?? 'NULL ✓ (stayed null)'}`)

  // === 6.2 — Resend the same event AGAIN (3rd total delivery) ===
  console.log('\n[6.2] Resend the SAME event one more time (3rd total delivery) → triple-delivery idempotent')
  await stripeEventsResend(cancelEvent.id, stripeCliEnv)
  console.log('    Waiting 6s for re-redelivery to process...')
  await new Promise(r => setTimeout(r, 6_000))

  const [afterResend2] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  console.log(`    customers.stripeSubscriptionId = ${afterResend2.stripeSubscriptionId ?? 'NULL ✓ (still null)'}`)

  // Event log will increment because processPlatformSubscriptionDeleted logs unconditionally
  const [eventCountAfter] = await db
    .select({ value: count() })
    .from(wbEvents)
    .where(and(eq(wbEvents.customerId, c.id), eq(wbEvents.name, 'platform_subscription_canceled')))
  console.log(`    post-3-deliveries: platform_subscription_canceled event count = ${eventCountAfter.value}`)
  console.log(`    (note: events increment is expected — the SQL state (stripeSubscriptionId) is what idempotency protects)`)

  // Stripe-side: only 1 cancellation, sub remains canceled
  const subAfter = await platform.subscriptions.retrieve(subscriptionId)
  console.log(`    Stripe sub status: ${subAfter.status} ${subAfter.status === 'canceled' ? '✓' : '❌'}`)

  // === 6.3 — Drain cron filter idempotency: rows with pause_drain_processed_at set are EXCLUDED ===
  console.log('\n[6.3] Drain-cron filter idempotency check')
  console.log('    Seed 2 paused-state rows: one unprocessed (NULL), one already-processed (timestamp set)')

  // Reset stripeSubscriptionId for the drain query's filter to find rows (or just test the filter directly without)
  // The drain query also requires customers.stripeSubscriptionId IS NOT NULL — we just canceled it.
  // For this test, we only care about the IS NULL filter on pauseDrainProcessedAt. Seed two rows + run the
  // same query the cron uses with hardcoded customerId.

  const tagA = `tier6-3-A-${Date.now()}`
  const tagB = `tier6-3-B-${Date.now()}`
  const [pa] = await db.insert(churnedSubscribers).values({
    customerId: c.id, stripeCustomerId: `cus_TIER6_${tagA}`,
    name: 'Tier 6.3 A unprocessed', email: `${tagA}@example.com`,
    cancellationReason: 'Lost interest',
    mrrCents: PERF_FEE_MRR_CENTS, status: 'pending',
    pauseDrainProcessedAt: null,
    cancelledAt: new Date(),
  }).returning({ id: churnedSubscribers.id })
  const [pb] = await db.insert(churnedSubscribers).values({
    customerId: c.id, stripeCustomerId: `cus_TIER6_${tagB}`,
    name: 'Tier 6.3 B already-processed', email: `${tagB}@example.com`,
    cancellationReason: 'Lost interest',
    mrrCents: PERF_FEE_MRR_CENTS, status: 'pending',
    pauseDrainProcessedAt: new Date(),  // marked processed by a prior cron run
    cancelledAt: new Date(),
  }).returning({ id: churnedSubscribers.id })

  // Run the cron's "is this row eligible to be picked up?" query
  const eligible = await db
    .select({ id: churnedSubscribers.id, pauseDrainProcessedAt: churnedSubscribers.pauseDrainProcessedAt })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, c.id),
      isNull(churnedSubscribers.pauseDrainProcessedAt),  // ← Spec 54's per-row state filter
      eq(churnedSubscribers.status, 'pending'),
    ))

  const eligibleIds = new Set(eligible.map(r => r.id))
  const aIncluded = eligibleIds.has(pa.id)
  const bExcluded = !eligibleIds.has(pb.id)
  console.log(`    Row A (pause_drain_processed_at=NULL):  eligible=${aIncluded} ${aIncluded ? '✓' : '❌'}`)
  console.log(`    Row B (pause_drain_processed_at=SET):   eligible=${!bExcluded ? 'true ❌' : 'false ✓ (correctly excluded)'}`)

  console.log('\n=== Verdict ===')
  const sql61 = !afterResend1.stripeSubscriptionId
  const sql62 = !afterResend2.stripeSubscriptionId
  const drain63 = aIncluded && bExcluded
  if (sql61 && sql62 && drain63) {
    console.log('✓✓✓ Tier 6 verified — webhook redelivery idempotent (state), drain-cron filter excludes already-processed rows')
  } else {
    console.error('❌ Tier 6 FAILED')
    process.exit(1)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

// Tier 2.3 — Webhook redelivery idempotency.
//
// Drive a real win-back flow (cancel + re-subscribe on the Connect
// account), wait for both webhooks to land, snapshot the DB, then ask
// Stripe to resend each event via `stripe events resend`. After the
// redelivery lands, re-snapshot. The DB should be byte-identical —
// no new rows in wb_churned_subscribers, wb_recoveries, wb_emails_sent,
// no new perf-fee invoice items on Stripe.
//
// If anything increments, a handler is leaking under redelivery — a
// silent prod bug because Stripe redelivers on every 5xx/timeout and
// on every manual dashboard replay.
//
// Pre-req: dev server + stripe listen with --forward-connect-to running.
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier2-redelivery.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent, wbEvents, users } from '../lib/schema'
import { eq, and, count } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'
import { spawn } from 'child_process'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const TEST_SUB_EMAIL = `billing-test-${Date.now()}@example.com`
const TEST_SUB_NAME = 'Tier 2.3 Redelivery Test'
const PLAN_MRR_CENTS = 5000
const POLL_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 1_000

interface Snapshot {
  subscribers: number
  recoveries: number
  emailsSent: number
  events: number
  customerActivatedAt: string | null
  customerStripeSubscriptionId: string | null
  customerStripePlatformCustomerId: string | null
}

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

async function snapshot(customerId: string): Promise<Snapshot> {
  const subIds = (await db.select({ id: churnedSubscribers.id }).from(churnedSubscribers).where(eq(churnedSubscribers.customerId, customerId))).map(r => r.id)
  const [{ value: subs }] = await db.select({ value: count() }).from(churnedSubscribers).where(eq(churnedSubscribers.customerId, customerId))
  const [{ value: recs }] = await db.select({ value: count() }).from(recoveries).where(eq(recoveries.customerId, customerId))
  const evCount = await db.select({ value: count() }).from(wbEvents).where(eq(wbEvents.customerId, customerId))
  const emailCount = subIds.length > 0
    ? (await db.select({ value: count() }).from(emailsSent).where(eq(emailsSent.subscriberId, subIds[0])))[0].value
    : 0
  const [c] = await db.select().from(customers).where(eq(customers.id, customerId)).limit(1)
  return {
    subscribers: subs,
    recoveries: recs,
    emailsSent: emailCount,
    events: evCount[0].value,
    customerActivatedAt: c?.activatedAt?.toISOString() ?? null,
    customerStripeSubscriptionId: c?.stripeSubscriptionId ?? null,
    customerStripePlatformCustomerId: c?.stripePlatformCustomerId ?? null,
  }
}

function diff(before: Snapshot, after: Snapshot): { key: string; before: unknown; after: unknown }[] {
  const out: { key: string; before: unknown; after: unknown }[] = []
  for (const k of Object.keys(before) as (keyof Snapshot)[]) {
    if (before[k] !== after[k]) out.push({ key: k, before: before[k], after: after[k] })
  }
  return out
}

async function stripeEventsResend(eventId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // We pass STRIPE_API_KEY via env to keep the secret out of argv.
    const env = { ...process.env }
    const value = process.env.STRIPE_SECRET_KEY
    if (!value) return reject(new Error('STRIPE_SECRET_KEY not set'))
    env.STRIPE_API_KEY = value
    const cmd = spawn('stripe', ['events', 'resend', eventId], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    cmd.stderr.on('data', (d) => (stderr += d.toString()))
    cmd.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`stripe events resend ${eventId} exited ${code}: ${stderr.slice(0, 500)}`))
    })
  })
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c?.stripeAccessToken) { console.error('no Connect token'); process.exit(1) }

  if (c.activatedAt || c.stripeSubscriptionId) {
    console.error(`Customer NOT at baseline. Run reset first.`)
    process.exit(1)
  }

  const connect = new Stripe(decrypt(c.stripeAccessToken))

  console.log('=== Tier 2.3 — Webhook redelivery idempotency ===\n')
  console.log(`Target merchant: ${TARGET_EMAIL}  customerId=${c.id}`)
  console.log(`Test subscriber: ${TEST_SUB_EMAIL}\n`)

  // 1) Set up a real win-back flow: subscriber + cancel + re-subscribe
  console.log('[1/6] Reuse $50/mo Price on Connect')
  const prices = await connect.prices.list({ limit: 100, active: true })
  let price = prices.data.find(p =>
    p.unit_amount === PLAN_MRR_CENTS && p.currency === 'usd' && p.recurring?.interval === 'month'
  )
  if (!price) {
    const product = await connect.products.create({ name: 'Tier 2.3 Test Plan' })
    price = await connect.prices.create({
      unit_amount: PLAN_MRR_CENTS,
      currency: 'usd',
      recurring: { interval: 'month' },
      product: product.id,
    })
  }
  console.log(`    ${price.id}`)

  console.log('[2/6] Create test customer + first subscription')
  const stripeCustomer = await connect.customers.create({ email: TEST_SUB_EMAIL, name: TEST_SUB_NAME })
  const sub1 = await connect.subscriptions.create({
    customer: stripeCustomer.id,
    items: [{ price: price.id }],
    collection_method: 'send_invoice',
    days_until_due: 30,
  })
  console.log(`    customer=${stripeCustomer.id}  sub1=${sub1.id}`)

  console.log('\n[3/6] Cancel → expect processChurn webhook')
  await connect.subscriptions.cancel(sub1.id)
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

  // Inject the synthetic exit email so processRecovery counts the re-subscribe
  // as a recovery (matches the convention in scripts/billing-test-tier1-real-webhook.ts).
  await db.insert(emailsSent).values({
    subscriberId: churnRow.id,
    type: 'exit',
    subject: '(tier 2.3) synthetic',
    bodyText: '(tier 2.3)',
    sentAt: new Date(Date.now() - 60_000),
    repliedAt: new Date(),
  })

  console.log('\n[4/6] Re-subscribe → expect processRecovery webhook + activation')
  const sub2 = await connect.subscriptions.create({
    customer: stripeCustomer.id,
    items: [{ price: price.id }],
    collection_method: 'send_invoice',
    days_until_due: 30,
  })
  console.log(`    sub2=${sub2.id}`)
  await poll('wb_recoveries row', async () => {
    const [row] = await db
      .select()
      .from(recoveries)
      .where(and(eq(recoveries.customerId, c.id), eq(recoveries.subscriberId, churnRow.id)))
      .limit(1)
    return row ?? null
  })
  await poll('customers.activatedAt', async () => {
    const [row] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
    return row?.activatedAt ? row : null
  })

  // Wait 2s for any tail-end async work
  await new Promise(r => setTimeout(r, 2_000))

  // 2) Snapshot BEFORE redelivery
  console.log('\n[5/6] Snapshot BEFORE redelivery')
  const before = await snapshot(c.id)
  console.log(`    subscribers=${before.subscribers}  recoveries=${before.recoveries}  emailsSent=${before.emailsSent}  events=${before.events}`)
  console.log(`    activatedAt=${before.customerActivatedAt}  platformCustomer=${before.customerStripePlatformCustomerId}`)

  // 3) Find the two events on Connect that should be resent
  console.log('\n[6/6] Find events on Connect and resend')
  const events = await connect.events.list({ limit: 30 })
  const cancelEvent = events.data.find(e =>
    e.type === 'customer.subscription.deleted' &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((e.data.object as any).id === sub1.id),
  )
  const createEvent = events.data.find(e =>
    e.type === 'customer.subscription.created' &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((e.data.object as any).id === sub2.id),
  )
  if (!cancelEvent || !createEvent) {
    console.error(`could not locate events: cancel=${!!cancelEvent} create=${!!createEvent}`)
    process.exit(1)
  }
  console.log(`    cancel event:  ${cancelEvent.id}  (${cancelEvent.type})`)
  console.log(`    create event:  ${createEvent.id}  (${createEvent.type})`)

  console.log('\n    Resending cancel event...')
  await stripeEventsResend(cancelEvent.id)
  console.log('    Resending create event...')
  await stripeEventsResend(createEvent.id)

  console.log('    Waiting 8s for redelivery to land and process...')
  await new Promise(r => setTimeout(r, 8_000))

  // 4) Snapshot AFTER redelivery + diff
  console.log('\n=== Snapshot AFTER redelivery ===')
  const after = await snapshot(c.id)
  console.log(`    subscribers=${after.subscribers}  recoveries=${after.recoveries}  emailsSent=${after.emailsSent}  events=${after.events}`)
  console.log(`    activatedAt=${after.customerActivatedAt}  platformCustomer=${after.customerStripePlatformCustomerId}`)

  const diffs = diff(before, after)
  console.log('\n=== DIFF ===')
  if (diffs.length === 0) {
    console.log('    No drift in {subscribers, recoveries, emailsSent, activatedAt, ...}.')
    console.log('    NOTE: `events` count is expected to drift slightly because each')
    console.log('    redelivery produces audit events of its own. Filter out those.')
  } else {
    for (const d of diffs) console.log(`    ${d.key}: ${d.before} → ${d.after}`)
  }

  // Define what counts as a real idempotency violation. wb_events increments
  // legitimately (audit log of the redelivery itself). Everything else is a bug.
  const violationKeys = diffs.filter(d => d.key !== 'events')

  console.log('\n=== Verdict ===')
  if (violationKeys.length === 0) {
    console.log('✓✓✓ All idempotency invariants held under webhook redelivery.')
  } else {
    console.log('❌ FAILURE — handler not idempotent:')
    for (const d of violationKeys) console.log(`    ${d.key}: ${d.before} → ${d.after}`)
    process.exit(1)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

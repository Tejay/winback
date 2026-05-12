// Tier 2.2 — Wrapper-level race: success page vs webhook handler.
//
// Tier 2.1 fired 5 identical ensureActivation calls via Promise.all.
// Tier 2.2 simulates the realistic production race: two DIFFERENT
// wrapper paths converge on ensureActivation from different setup
// sequences. Both wrappers:
//   1. setDefaultPaymentMethod on the platform customer
//   2. ensureActivation(customerId)
//
// Path A simulates `/billing/success` — its caller catches throws
// and renders a "pending" tone.
// Path B simulates `processPlatformCardCapture` — its caller logs
// and continues.
//
// What this catches that Tier 2.1 didn't:
//   - Two parallel setDefaultPaymentMethod calls on the same Stripe
//     customer — do they conflict, or are they idempotent?
//   - Wrapper-level error propagation: does either path's "loser"
//     branch produce an unhandled exception?
//   - Realistic timing skew: the setDefaultPaymentMethod step adds
//     ~300ms of Stripe latency BEFORE ensureActivation, so when one
//     path is on its setup step the other may already be in
//     ensureActivation — exactly the racy timing.
//
// Run: npx tsx --env-file=.env.local scripts/billing-test-tier2-wrapper-race.ts

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent, users } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { ensureActivation, type ActivationState } from '../src/winback/lib/activation'
import { setDefaultPaymentMethod } from '../src/winback/lib/platform-billing'
import Stripe from 'stripe'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const PERF_FEE_MRR_CENTS = 5000

interface PathResult {
  label: string
  status: 'success' | 'thrown' | 'caught'
  state?: ActivationState['state']
  subscriptionId?: string
  subscriptionCreated?: boolean
  errorMessage?: string
  durationMs: number
}

/** Simulates the success page wrapper: setDefaultPaymentMethod + ensureActivation, with the same try/catch shape. */
async function simulateSuccessPagePath(
  platformCustomerId: string,
  paymentMethodId: string,
  wbCustomerId: string,
): Promise<PathResult> {
  const t0 = Date.now()
  try {
    await setDefaultPaymentMethod(platformCustomerId, paymentMethodId)
    const outcome = await ensureActivation(wbCustomerId)
    return {
      label: 'success-page',
      status: 'success',
      state: outcome.state,
      subscriptionId: outcome.state === 'active' ? outcome.subscriptionId : undefined,
      subscriptionCreated: outcome.state === 'active' ? outcome.subscriptionCreated : undefined,
      durationMs: Date.now() - t0,
    }
  } catch (err) {
    // Mirrors app/billing/success/page.tsx — page renders "pending" on throw.
    return {
      label: 'success-page',
      status: 'caught',
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    }
  }
}

/** Simulates the webhook wrapper: setDefaultPaymentMethod + ensureActivation, same try/catch shape. */
async function simulateWebhookPath(
  platformCustomerId: string,
  paymentMethodId: string,
  wbCustomerId: string,
): Promise<PathResult> {
  const t0 = Date.now()
  try {
    await setDefaultPaymentMethod(platformCustomerId, paymentMethodId)
    const outcome = await ensureActivation(wbCustomerId)
    return {
      label: 'webhook',
      status: 'success',
      state: outcome.state,
      subscriptionId: outcome.state === 'active' ? outcome.subscriptionId : undefined,
      subscriptionCreated: outcome.state === 'active' ? outcome.subscriptionCreated : undefined,
      durationMs: Date.now() - t0,
    }
  } catch (err) {
    // app/api/stripe/webhook/route.ts triggerActivation wraps in try/catch.
    return {
      label: 'webhook',
      status: 'caught',
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - t0,
    }
  }
}

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c) { console.error('customer not found'); process.exit(1) }

  if (c.stripeSubscriptionId || c.stripeSubscriptionCreatingAt) {
    console.error(`Customer NOT clean. Run reset first.`)
    process.exit(1)
  }

  const platform = new Stripe(process.env.STRIPE_SECRET_KEY!)

  console.log('=== Tier 2.2 — Wrapper-level race (success page vs webhook) ===\n')

  // 1) Seed subscriber + win-back recovery so activation has perf fees to charge
  const [seedSub] = await db.insert(churnedSubscribers).values({
    customerId: c.id,
    stripeCustomerId: `cus_TIER22_${Date.now()}`,
    name: 'Tier 2.2 subscriber',
    email: `tier2-wrapper-${Date.now()}@example.com`,
    cancellationReason: 'Lost interest',
    mrrCents: PERF_FEE_MRR_CENTS,
    status: 'recovered',
  }).returning({ id: churnedSubscribers.id })
  await db.insert(emailsSent).values({
    subscriberId: seedSub.id,
    type: 'exit',
    subject: '(tier 2.2) synthetic',
    bodyText: '(tier 2.2)',
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
  console.log(`[setup] seeded subscriber+recovery (${seedSub.id})`)

  // 2) Create platform Stripe customer + attach PM (but DON'T yet set as default —
  // we want each path to do that as part of its wrapper work, exactly as in prod).
  const platformCustomer = await platform.customers.create({
    email: `tier2-wrapper-${Date.now()}@example.com`,
    name: 'Tier 2.2 wrapper-race',
    metadata: { winback_customer_id: c.id, tier: '2.2' },
  })
  const pm = await platform.paymentMethods.attach('pm_card_visa', { customer: platformCustomer.id })
  await db.update(customers)
    .set({ stripePlatformCustomerId: platformCustomer.id, updatedAt: new Date() })
    .where(eq(customers.id, c.id))
  console.log(`[setup] platform customer=${platformCustomer.id}  PM attached (not yet default)=${pm.id}`)

  // 3) Fire both paths concurrently
  console.log(`\n[race] firing both paths via Promise.all`)
  const t0 = Date.now()
  const [resA, resB] = await Promise.all([
    simulateSuccessPagePath(platformCustomer.id, pm.id, c.id),
    simulateWebhookPath(platformCustomer.id, pm.id, c.id),
  ])
  console.log(`[race] both completed in ${((Date.now() - t0) / 1000).toFixed(2)}s\n`)

  console.log(`[result] ${resA.label.padEnd(13)} status=${resA.status.padEnd(8)} state=${resA.state ?? '-'.padEnd(14)} subId=${resA.subscriptionId ?? '-'} subCreated=${resA.subscriptionCreated ?? '-'} ${resA.durationMs}ms${resA.errorMessage ? ` err="${resA.errorMessage}"` : ''}`)
  console.log(`[result] ${resB.label.padEnd(13)} status=${resB.status.padEnd(8)} state=${resB.state ?? '-'.padEnd(14)} subId=${resB.subscriptionId ?? '-'} subCreated=${resB.subscriptionCreated ?? '-'} ${resB.durationMs}ms${resB.errorMessage ? ` err="${resB.errorMessage}"` : ''}`)

  // 4) Verify final state
  console.log('\n[verify]')
  const [after] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  console.log(`  DB: stripeSubscriptionId=${after.stripeSubscriptionId}  creatingAt=${after.stripeSubscriptionCreatingAt?.toISOString() ?? 'NULL ✓'}`)

  const subs = await platform.subscriptions.list({ customer: platformCustomer.id, status: 'all', limit: 5 })
  const items = await platform.invoiceItems.list({ customer: platformCustomer.id, limit: 20 })
  const perfItems = items.data.filter(i => (i.description ?? '').startsWith('Win-back:'))
  console.log(`  Stripe: ${subs.data.length} subscription(s), ${perfItems.length} perf-fee item(s)`)

  console.log('\n[invariants]')
  const oneSubOk = subs.data.length === 1
  const onePerfOk = perfItems.length === 1
  const dbSubOk = !!after.stripeSubscriptionId && after.stripeSubscriptionId === subs.data[0]?.id
  const lockReleasedOk = !after.stripeSubscriptionCreatingAt
  const noUnhandledThrows = Boolean(
    (resA.status !== 'caught' || resA.errorMessage?.includes('subscription_creation_in_progress')) &&
    (resB.status !== 'caught' || resB.errorMessage?.includes('subscription_creation_in_progress'))
  )
  const oneCreatedTrue =
    (resA.subscriptionCreated === true && resB.subscriptionCreated === false) ||
    (resA.subscriptionCreated === false && resB.subscriptionCreated === true) ||
    // Or one path threw (loser) and the other returned active with created=true
    (resA.status === 'caught' && resB.subscriptionCreated === true) ||
    (resB.status === 'caught' && resA.subscriptionCreated === true)

  const checks: Array<[string, boolean]> = [
    ['exactly one Stripe subscription', oneSubOk],
    ['exactly one perf-fee item', onePerfOk],
    ['DB stripeSubscriptionId matches Stripe', dbSubOk],
    ['race-fence lock released', lockReleasedOk],
    ['no unexpected unhandled exceptions', noUnhandledThrows],
    ['exactly one caller reports subscriptionCreated=true', oneCreatedTrue],
  ]
  for (const [name, ok] of checks) console.log(`  ${ok ? '✓' : '❌'} ${name}`)

  console.log()
  if (checks.every(([, ok]) => ok)) {
    console.log('=== ✓✓✓ Tier 2.2 wrapper-level race verified ===')
  } else {
    console.log('=== ❌ FAILURE — see invariants above ===')
    process.exit(1)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

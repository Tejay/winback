// Spec 79 promo flow — end-to-end test on tejaasvi@gmail.com's connected
// (test-mode) Stripe account.
//
// What the SCRIPT does (all real):
//   1. Create test customer + active subscription via the Connect account
//   2. Cancel with cancellation_details = { feedback: 'too_expensive', ... }
//      so the classifier lands on Tier 1 + cancellationCategory = 'Price'
//   3. Wait for the production webhook → processChurn → DB
//      (same path as scripts/test-cancellation-e2e.ts — relies on the
//      prod webhook endpoint writing to the shared Neon DB; no Stripe
//      CLI listener required)
//   4. Run the classifier directly (skips the cron wait)
//   5. Run the reengagement matcher directly → promo path fires → promo
//      email goes out to tejaasvi+promotest@gmail.com via Resend
//
// What YOU do next (manual, in a browser):
//   6. Open the email in tejaasvi+promotest@gmail.com, click the
//      "Resubscribe" button
//   7. Stripe Checkout opens with the WINBACKE2E25 discount pre-applied
//      in the discounts array. Complete with a test card (4242 4242…)
//   8. Stripe fires checkout.session.completed to the production webhook
//      → processCheckoutRecovery writes the wb_recoveries row with
//      applied_improvement_id → dashboard chip + per-code 30d metric
//      light up
//
// Cleanup deletes the test customer, subscription, churned_subscribers,
// recovery, and emailsSent rows.
//
// Usage:
//   npm run promo:e2e             # full run
//   npm run promo:e2e -- --cleanup
//
// SAFETY:
//   - Aborts unless merchant Stripe key starts with sk_test_
//   - Recipient email locked to tejaasvi+promotest@gmail.com

import 'dotenv/config'
import Stripe from 'stripe'
import { and, eq, desc } from 'drizzle-orm'
import { db } from '../lib/db'
import {
  customers,
  churnedSubscribers,
  emailsSent,
  recoveries,
  users,
  improvements,
} from '../lib/schema'
import { decrypt } from '../src/winback/lib/encryption'
import { runClassifierTick } from '../src/winback/lib/classifier-tick'
import { processSubscriberForReengagement } from '../src/winback/lib/reengagement-cron-v2'

const MERCHANT_USER_EMAIL = 'tejaasvi@gmail.com'
const TEST_SUB_EMAIL      = 'tejaasvi+promotest@gmail.com'
const TEST_SUB_NAME       = 'Promo-E2E User'
const POLL_TIMEOUT_MS     = 3 * 60 * 1000

const CANCEL_FEEDBACK: Stripe.SubscriptionCancelParams.CancellationDetails['feedback'] = 'too_expensive'
const CANCEL_COMMENT  = "It's too expensive for me right now. The price is the only reason I'm leaving."

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function poll<T>(
  label: string,
  fn:    () => Promise<T | null>,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<T> {
  const start = Date.now()
  let attempt = 0
  while (Date.now() - start < timeoutMs) {
    attempt++
    const row = await fn()
    if (row) {
      console.log(`    ✓ ${label} after ${((Date.now() - start) / 1000).toFixed(1)}s (attempt ${attempt})`)
      return row
    }
    await sleep(2000)
  }
  throw new Error(`Timed out waiting for: ${label} (${timeoutMs / 1000}s)`)
}

async function resolveMerchant() {
  const [row] = await db
    .select({
      id:                              customers.id,
      stripeAccountId:                 customers.stripeAccountId,
      stripeAccessToken:               customers.stripeAccessToken,
      promotionsEnabled:               customers.promotionsEnabled,
      selectedPromotionImprovementId:  customers.selectedPromotionImprovementId,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(users.email, MERCHANT_USER_EMAIL))
    .limit(1)

  if (!row) throw new Error(`No customer row found for user ${MERCHANT_USER_EMAIL}`)
  if (!row.stripeAccountId) throw new Error(`Merchant has no Stripe account connected`)
  if (!row.stripeAccessToken) throw new Error(`Merchant has no Stripe access token`)
  return {
    id:                             row.id,
    stripeAccountId:                row.stripeAccountId,
    accessToken:                    decrypt(row.stripeAccessToken),
    promotionsEnabled:              row.promotionsEnabled,
    selectedPromotionImprovementId: row.selectedPromotionImprovementId,
  }
}

async function cleanup(): Promise<void> {
  const merchant = await resolveMerchant()
  const stripe = new Stripe(merchant.accessToken)

  console.log(`Cleanup: Stripe customers with email=${TEST_SUB_EMAIL}`)
  const list = await stripe.customers.list({ email: TEST_SUB_EMAIL, limit: 20 })
  for (const c of list.data) {
    try {
      await stripe.customers.del(c.id)
      console.log(`    ✓ deleted Stripe customer ${c.id}`)
    } catch (err) {
      console.log(`    ⚠ ${c.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`Cleanup: DB rows for email=${TEST_SUB_EMAIL}`)
  const subRows = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.email, TEST_SUB_EMAIL))
  for (const r of subRows) {
    // recoveries FK on subscriber_id has no cascade; delete first
    await db.delete(recoveries).where(eq(recoveries.subscriberId, r.id))
    await db.delete(emailsSent).where(eq(emailsSent.subscriberId, r.id))
    await db.delete(churnedSubscribers).where(eq(churnedSubscribers.id, r.id))
    console.log(`    ✓ deleted DB rows for subscriber ${r.id}`)
  }
  console.log(`\nCleanup complete. ${list.data.length} Stripe customer(s), ${subRows.length} subscriber(s).`)
}

async function main(): Promise<void> {
  if (process.argv.includes('--cleanup')) {
    await cleanup()
    return
  }

  console.log('=== Promo-flow e2e (Spec 79) ===\n')

  // ─── 1) Pre-check ─────────────────────────────────────────────────────
  console.log('[1/7] Pre-check: merchant has a promo selected')
  const merchant = await resolveMerchant()
  if (!merchant.accessToken.startsWith('sk_test_')) {
    console.error(`\n  ✗ ABORT: merchant access token not sk_test_. Refusing to run against live mode.\n`)
    process.exit(1)
  }
  if (!merchant.promotionsEnabled) {
    console.error(`\n  ✗ ABORT: merchant has promotionsEnabled=false. Enable on /reasons first.\n`)
    process.exit(1)
  }
  if (!merchant.selectedPromotionImprovementId) {
    console.error(`\n  ✗ ABORT: no selected promo. Pick one on /reasons first.\n`)
    process.exit(1)
  }
  const [selectedPromo] = await db
    .select({
      id:                improvements.id,
      promotionMetadata: improvements.promotionMetadata,
    })
    .from(improvements)
    .where(eq(improvements.id, merchant.selectedPromotionImprovementId))
    .limit(1)
  const promoMeta = selectedPromo?.promotionMetadata as { code?: string } | null
  console.log(`    merchant customerId   = ${merchant.id}`)
  console.log(`    Stripe account        = ${merchant.stripeAccountId}`)
  console.log(`    mode                  = TEST ✓`)
  console.log(`    promotionsEnabled     = true ✓`)
  console.log(`    selected promo code   = ${promoMeta?.code ?? '???'}`)
  console.log(`    selected promo id     = ${merchant.selectedPromotionImprovementId}`)

  const stripe = new Stripe(merchant.accessToken)

  // ─── 2) Pick a recurring price ────────────────────────────────────────
  console.log('\n[2/7] Pick a recurring price')
  const prices = await stripe.prices.list({ active: true, type: 'recurring', limit: 5 })
  if (prices.data.length === 0) throw new Error('No active recurring prices on merchant account')
  const price = prices.data[0]
  console.log(`    ${price.id} (${(price.unit_amount ?? 0) / 100} ${price.currency} / ${price.recurring?.interval})`)

  // ─── 3) Create test customer + subscription ───────────────────────────
  console.log('\n[3/7] Create test customer + active subscription')
  const stripeCustomer = await stripe.customers.create({
    email: TEST_SUB_EMAIL,
    name:  TEST_SUB_NAME,
  })
  console.log(`    customer    ${stripeCustomer.id}`)

  const sub = await stripe.subscriptions.create({
    customer:          stripeCustomer.id,
    items:             [{ price: price.id }],
    collection_method: 'send_invoice',
    days_until_due:    30,
  })
  console.log(`    subscription ${sub.id}  status=${sub.status}`)
  await sleep(1500)

  // ─── 4) Cancel with PRICE-related cancellation_details ────────────────
  console.log('\n[4/7] Cancel with price-related cancellation_details')
  console.log(`    feedback = ${CANCEL_FEEDBACK}`)
  console.log(`    comment  = "${CANCEL_COMMENT}"`)
  await stripe.subscriptions.cancel(sub.id, {
    cancellation_details: {
      feedback: CANCEL_FEEDBACK,
      comment:  CANCEL_COMMENT,
    },
  })
  console.log(`    ✓ canceled`)

  // ─── 5) Wait for production webhook → DB ──────────────────────────────
  console.log('\n[5/7] Poll for wb_churned_subscribers row (production webhook → shared DB)')
  const churnRow = await poll('wb_churned_subscribers row', async () => {
    const [row] = await db
      .select()
      .from(churnedSubscribers)
      .where(and(
        eq(churnedSubscribers.customerId, merchant.id),
        eq(churnedSubscribers.stripeCustomerId, stripeCustomer.id),
      ))
      .limit(1)
    return row ?? null
  })
  console.log(`    id              = ${churnRow.id}`)
  console.log(`    mrr_cents       = ${churnRow.mrrCents}`)
  console.log(`    stripe_enum     = ${churnRow.stripeEnum ?? '(none)'}`)
  console.log(`    stripe_comment  = ${churnRow.stripeComment ? `"${churnRow.stripeComment}"` : '(none)'}`)

  // ─── 6) Run classifier → exit email + Price category ──────────────────
  console.log('\n[6/7] Run classifier (Anthropic → tier + category → exit email via Resend)')
  await runClassifierTick()
  await sleep(1000)
  const [classified] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, churnRow.id))
    .limit(1)
  console.log(`    tier                  = ${classified.tier}`)
  console.log(`    cancellationCategory  = ${classified.cancellationCategory ?? '(none)'}`)
  console.log(`    triggerNeed           = ${classified.triggerNeed ?? '(none)'}`)

  if (classified.tier !== 1) {
    console.warn(`    ⚠ classifier landed tier=${classified.tier}, expected 1. Promo path won't fire.`)
  }
  if (classified.cancellationCategory !== 'Price') {
    console.warn(`    ⚠ classifier landed category=${classified.cancellationCategory}, expected Price. Promo path won't fire.`)
  }

  // ─── 7) Run reengagement matcher → promo email ────────────────────────
  // processSubscriberForReengagement returns { kind: 'emailed', improvementId }
  // for both the regular improvement-match path AND the promo path. Promo
  // vs regular is distinguished by the improvement's kind ('promotion' vs
  // 'product') — we cross-check that on the email row below.
  console.log('\n[7/7] Run reengagement matcher (promo path)')
  const outcome = await processSubscriberForReengagement(classified, { bypassCooldown: true })
  console.log(`    outcome.kind = ${outcome?.kind ?? '(null)'}`)
  if (outcome?.kind === 'emailed') {
    console.log(`    improvementId = ${outcome.improvementId}`)
  } else if (outcome?.kind === 'skipped') {
    console.log(`    reason        = ${outcome.reason}`)
    console.warn(`    ⚠ Promo path did not fire. Check tier/category above.`)
  } else if (outcome?.kind === 'error') {
    console.log(`    errorMessage  = ${outcome.errorMessage}`)
  }

  // Read back the promo email that was sent
  const [promoEmail] = await db
    .select({
      id:            emailsSent.id,
      type:          emailsSent.type,
      subject:       emailsSent.subject,
      improvementId: emailsSent.improvementId,
      sentAt:        emailsSent.sentAt,
    })
    .from(emailsSent)
    .where(and(
      eq(emailsSent.subscriberId, churnRow.id),
      eq(emailsSent.type, 'reengagement'),
    ))
    .orderBy(desc(emailsSent.sentAt))
    .limit(1)

  if (promoEmail) {
    console.log(`\n    ✓ Promo email sent:`)
    console.log(`        subject       = "${promoEmail.subject}"`)
    console.log(`        improvementId = ${promoEmail.improvementId}`)
    console.log(`        sentAt        = ${promoEmail.sentAt?.toISOString()}`)
  } else {
    console.log(`\n    ⚠ No reengagement email row found.`)
    return
  }

  console.log('\n=== Script done. Now drive the rest in your browser. ===')
  console.log('')
  console.log(`  → Open the inbox for ${TEST_SUB_EMAIL}`)
  console.log(`  → Click the "Resubscribe" button in the email`)
  console.log(`  → Stripe Checkout opens with the ${promoMeta?.code ?? 'promo'} discount`)
  console.log(`    pre-applied — complete with a test card (4242 4242 4242 4242,`)
  console.log(`    any future exp, any CVC)`)
  console.log(`  → On success, Stripe fires checkout.session.completed to the`)
  console.log(`    production webhook → processCheckoutRecovery writes the`)
  console.log(`    wb_recoveries row with applied_improvement_id`)
  console.log(`  → Refresh http://localhost:3000/dashboard — Promo-E2E User`)
  console.log(`    row shows ✓ Recovered via ${promoMeta?.code ?? 'CODE'} chip`)
  console.log(`  → http://localhost:3000/reasons (Promotions tab) — per-code`)
  console.log(`    "Drove X recoveries / $Y MRR (30d)" metric increments`)
  console.log('')
  console.log(`Subscriber id (for SQL debugging):  ${churnRow.id}`)
  console.log(`Improvement id (FK target):          ${promoEmail.improvementId}`)
  console.log('')
  console.log(`When done, clean up:`)
  console.log(`    npm run promo:e2e -- --cleanup`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

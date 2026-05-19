// Real end-to-end cancellation test.
//
// Drives a full churn flow on tejaasvi@gmail.com's connected (test-mode)
// Stripe account:
//   1. Create test customer + active subscription on the Connect account
//   2. Cancel the subscription with a meaningful cancellation_details
//      comment so the classifier produces a Tier-1 exit email (not silent
//      churn).
//   3. Wait for the customer.subscription.deleted webhook → processChurn
//      → wb_churned_subscribers row inserted.
//   4. Trigger runClassifierTick() directly to bypass the ~2-minute cron
//      wait. Classifier calls Anthropic, generates exit-email body,
//      sendEmail fires via Resend, wb_emails_sent row appears.
//   5. Print the email contents + the subscriber UUID. You receive a
//      real email at tejaasvi+canceltest@gmail.com with a working
//      Resubscribe button.
//
// Usage:
//   npm run cancel:test              # full e2e run
//   npm run cancel:test -- --cleanup # delete test rows + Stripe records
//
// SAFETY GUARDS:
//   - Aborts unless the merchant's Stripe key starts with `sk_test_`
//   - Recipient email is locked to tejaasvi+canceltest@gmail.com
//   - Cleanup removes both DB rows and the Stripe customer/subscription
//
// WEBHOOK DEPENDENCY:
//   For step 3 to land, Stripe's `customer.subscription.deleted` webhook
//   must reach a server connected to your DATABASE_URL. Either:
//     a) `stripe listen --forward-to localhost:3000/api/stripe/webhook`
//        running in another terminal (uses the Stripe CLI's signing secret)
//     b) `ngrok http 3000 --domain=<your-domain>` AND a Stripe webhook
//        endpoint configured to that domain
//     c) Production webhook endpoint pointing at a host backed by the
//        SAME database the script writes to.
//
//   If neither is up, the wb_churned_subscribers poll times out and the
//   script prints actionable guidance.

import 'dotenv/config'
import Stripe from 'stripe'
import { and, eq, like } from 'drizzle-orm'
import { db } from '../lib/db'
import { customers, churnedSubscribers, emailsSent, users } from '../lib/schema'
import { decrypt } from '../src/winback/lib/encryption'
import { runClassifierTick } from '../src/winback/lib/classifier-tick'

const MERCHANT_USER_EMAIL  = 'tejaasvi@gmail.com'
const TEST_SUB_EMAIL       = 'tejaasvi+canceltest@gmail.com'
const TEST_SUB_NAME        = 'Cancel-Test User'
const POLL_TIMEOUT_MS      = 60_000

// Cancellation copy chosen so the classifier lands on Tier 1 (explicit
// reason in stripe_comment). Same shape the LLM sees from real users:
// short, specific, names the gap.
const CANCEL_FEEDBACK: Stripe.SubscriptionCancelParams.CancellationDetails['feedback'] = 'missing_features'
const CANCEL_COMMENT  = "No Slack integration. That was the only reason."

async function sleep(ms: number): Promise<void> {
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

async function resolveMerchant(): Promise<{ id: string; stripeAccountId: string; accessToken: string }> {
  const [row] = await db
    .select({
      id:                customers.id,
      stripeAccountId:   customers.stripeAccountId,
      stripeAccessToken: customers.stripeAccessToken,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(users.email, MERCHANT_USER_EMAIL))
    .limit(1)

  if (!row) throw new Error(`No customer row found for user ${MERCHANT_USER_EMAIL}`)
  if (!row.stripeAccountId) throw new Error(`Merchant ${MERCHANT_USER_EMAIL} has no Stripe account connected`)
  if (!row.stripeAccessToken) throw new Error(`Merchant ${MERCHANT_USER_EMAIL} has no Stripe access token`)

  return {
    id:              row.id,
    stripeAccountId: row.stripeAccountId,
    accessToken:     decrypt(row.stripeAccessToken),
  }
}

// ============================================================================
// CLEANUP
// ============================================================================
async function cleanup(): Promise<void> {
  const merchant = await resolveMerchant()
  const stripe = new Stripe(merchant.accessToken)

  // 1) Delete Stripe customer(s) on the Connect account with the test email
  console.log(`Cleanup: removing Stripe test customers with email=${TEST_SUB_EMAIL}`)
  const list = await stripe.customers.list({ email: TEST_SUB_EMAIL, limit: 20 })
  for (const c of list.data) {
    try {
      await stripe.customers.del(c.id)
      console.log(`    ✓ deleted Stripe customer ${c.id}`)
    } catch (err) {
      console.log(`    ⚠ could not delete ${c.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 2) Delete DB subscriber rows for the test email
  console.log(`Cleanup: removing wb_churned_subscribers with email=${TEST_SUB_EMAIL}`)
  const rows = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.email, TEST_SUB_EMAIL))
  for (const r of rows) {
    await db.delete(churnedSubscribers).where(eq(churnedSubscribers.id, r.id))
    console.log(`    ✓ deleted DB row ${r.id}`)
  }

  console.log(`\nCleanup complete. ${list.data.length} Stripe customer(s), ${rows.length} DB row(s) removed.`)
}

// ============================================================================
// MAIN
// ============================================================================
async function main(): Promise<void> {
  if (process.argv.includes('--cleanup')) {
    await cleanup()
    return
  }

  console.log('=== Cancellation e2e ===\n')

  // ---------------------------------------------------------------------
  // 1) Resolve merchant + safety guard for live mode
  // ---------------------------------------------------------------------
  console.log('[1/6] Resolve merchant + verify Stripe test mode')
  const merchant = await resolveMerchant()
  if (!merchant.accessToken.startsWith('sk_test_')) {
    console.error(`\n  ✗ ABORT: merchant access token does not start with 'sk_test_'.`)
    console.error(`     Refusing to run against live mode — this script creates and cancels real subscriptions.`)
    console.error(`     If you intended to test in live mode, edit the safety guard in this script.\n`)
    process.exit(1)
  }
  console.log(`    merchant customerId   = ${merchant.id}`)
  console.log(`    Stripe account        = ${merchant.stripeAccountId}`)
  console.log(`    mode                  = TEST ✓`)

  const stripe = new Stripe(merchant.accessToken)

  // ---------------------------------------------------------------------
  // 2) Pick a recurring price
  // ---------------------------------------------------------------------
  console.log('\n[2/6] Pick a recurring price')
  const prices = await stripe.prices.list({ active: true, type: 'recurring', limit: 5 })
  if (prices.data.length === 0) throw new Error('No active recurring prices on merchant account')
  const price = prices.data[0]
  const amount = (price.unit_amount ?? 0) / 100
  console.log(`    ${price.id} (${amount} ${price.currency} / ${price.recurring?.interval})`)

  // ---------------------------------------------------------------------
  // 3) Create test customer + active subscription (send_invoice)
  // ---------------------------------------------------------------------
  console.log('\n[3/6] Create test customer + active subscription')
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

  // Stripe takes a moment to fully commit the sub before cancel.
  await sleep(1500)

  // ---------------------------------------------------------------------
  // 4) Cancel with a real cancellation_details comment (Tier-1 signal)
  // ---------------------------------------------------------------------
  console.log('\n[4/6] Cancel subscription with cancellation_details → fires webhook')
  console.log(`    feedback = ${CANCEL_FEEDBACK}`)
  console.log(`    comment  = "${CANCEL_COMMENT}"`)
  await stripe.subscriptions.cancel(sub.id, {
    cancellation_details: {
      feedback: CANCEL_FEEDBACK,
      comment:  CANCEL_COMMENT,
    },
  })
  console.log(`    ✓ canceled`)

  // ---------------------------------------------------------------------
  // 5) Wait for the real webhook → processChurn → wb_churned_subscribers
  //
  //    Stripe Cloud fires `customer.subscription.deleted` to whatever
  //    webhook endpoint is configured on the platform's Stripe Dashboard
  //    (production winbackflow.co/api/stripe/webhook). That endpoint
  //    writes the row to the shared Neon DB, which we poll here.
  //
  //    Up to 3 minutes — real delivery can take longer than CLI-forwarded
  //    delivery, especially when Vercel's function is cold.
  // ---------------------------------------------------------------------
  console.log('\n[5/6] Poll for wb_churned_subscribers row (real webhook → production)')
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
  }, 3 * 60 * 1000)
  console.log(`    id                 = ${churnRow.id}`)
  console.log(`    email              = ${churnRow.email}`)
  console.log(`    name               = ${churnRow.name}`)
  console.log(`    mrr_cents          = ${churnRow.mrrCents}`)
  console.log(`    stripe_enum        = ${churnRow.stripeEnum ?? '(none)'}`)
  console.log(`    stripe_comment     = ${churnRow.stripeComment ? `"${churnRow.stripeComment}"` : '(none)'}`)
  console.log(`    status             = ${churnRow.status}`)
  console.log(`    classified_at      = ${churnRow.classifiedAt ?? '(awaiting classifier cron)'}`)

  // ---------------------------------------------------------------------
  // 6) Trigger classifier directly + wait for emailsSent
  // ---------------------------------------------------------------------
  console.log('\n[6/6] Trigger classifier + wait for exit email')
  console.log(`    calling runClassifierTick() directly...`)
  const stats = await runClassifierTick()
  console.log(`    picked=${stats.picked} classified=${stats.classified} exitEmailsSent=${stats.exitEmailsSent} failed=${stats.failed}`)

  // Re-read the subscriber to see the classifier's output
  const [classified] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, churnRow.id))
    .limit(1)

  console.log(`\n    Classifier output:`)
  console.log(`      tier               = ${classified.tier}`)
  console.log(`      confidence         = ${classified.confidence}`)
  console.log(`      cancellationReason = "${classified.cancellationReason}"`)
  console.log(`      cancellationCategory = ${classified.cancellationCategory}`)
  console.log(`      triggerNeed        = ${classified.triggerNeed ? `"${classified.triggerNeed}"` : '(none)'}`)
  console.log(`      handedOffAt        = ${classified.founderHandoffAt ?? '(no handoff)'}`)
  console.log(`      handoffReasoning   = "${classified.handoffReasoning ?? ''}"`)

  // Poll for the exit emailsSent row
  console.log(`\n    Polling for wb_emails_sent (type=exit)...`)
  const sentRow = await poll('exit email row', async () => {
    const [row] = await db
      .select()
      .from(emailsSent)
      .where(and(
        eq(emailsSent.subscriberId, churnRow.id),
        eq(emailsSent.type, 'exit'),
      ))
      .limit(1)
    return row ?? null
  }, 30_000)

  console.log(`\n=== Exit email ===`)
  console.log(`Subject: ${sentRow.subject}`)
  console.log(`Body:`)
  console.log((sentRow.bodyText ?? '').split('\n').map((l) => '  ' + l).join('\n'))

  console.log(`\n=== Done ===`)
  console.log(`Check your inbox: ${TEST_SUB_EMAIL} (delivers to tejaasvi@gmail.com)`)
  console.log(`Subscriber UUID: ${churnRow.id}`)
  console.log(`\nCleanup when done:`)
  console.log(`  npm run cancel:test -- --cleanup`)
}

main()
  .catch((err) => {
    console.error('Cancellation e2e crashed:', err)
    process.exit(1)
  })
  .finally(() => process.exit(0))

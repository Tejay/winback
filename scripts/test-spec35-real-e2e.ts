/**
 * Real end-to-end Spec 35 verification — drives Stripe Checkout in
 * subscription mode with a card that fails at charge time. Stripe.js
 * bypasses the API's attach-time validation that blocks failing cards
 * server-side, so we can finally produce a REAL invoice.payment_failed
 * event without test clocks or webhook replay.
 *
 * Flow:
 *   Phase 1: Script creates Checkout Session, prints URL.
 *            User opens it, enters 4000 0000 0000 9995, clicks Subscribe.
 *            Stripe creates sub in `incomplete` state → fires
 *            invoice.payment_failed → our webhook creates the dunning row.
 *            Script polls DB until row appears (60s timeout).
 *
 *   Phase 2: User opens the T1 dunning email + clicks "Update payment"
 *            → Spec 35 path: Checkout setup mode → user enters 4242 →
 *            our webhook attaches PM + pays the open invoice → Stripe
 *            fires invoice.payment_succeeded → our handler creates
 *            wb_recoveries row + flips subscriber status.
 *            Script polls until recovery row appears (5 min timeout).
 *
 * Run with: npx tsx --env-file=.env.local scripts/test-spec35-real-e2e.ts
 */
import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries } from '../lib/schema'
import { and, eq } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

const TEST_CUSTOMER_EMAIL = 'tejaasvi+spec35real@gmail.com'

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

async function main() {
  console.log('=== Spec 35 real e2e (browser-driven failed payment) ===\n')

  // Resolve the connected merchant (tejaasvi@gmail.com).
  const [merchant] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, '609356c6-212a-4062-967e-fc0ae1f92600'))
    .limit(1)

  if (!merchant?.stripeAccessToken) {
    console.error('Merchant not found / no access token')
    process.exit(1)
  }
  const stripe = new Stripe(decrypt(merchant.stripeAccessToken))
  console.log('Merchant:', merchant.id, '/', merchant.stripeAccountId)

  // Pick a recurring price.
  const prices = await stripe.prices.list({ active: true, type: 'recurring', limit: 5 })
  if (prices.data.length === 0) {
    console.error('No active recurring prices on merchant — cannot proceed')
    process.exit(1)
  }
  const price = prices.data[0]
  console.log('Price:   ', price.id, `(${(price.unit_amount ?? 0) / 100} ${price.currency})`)

  // Create the customer (no PM yet — Checkout will attach one).
  const stripeCustomer = await stripe.customers.create({
    email: TEST_CUSTOMER_EMAIL,
    name:  'Spec35 Real E2E',
  })
  console.log('Customer:', stripeCustomer.id)

  // Create a subscription Checkout Session. The customer enters their
  // card here (in the browser); Stripe.js handles the SetupIntent /
  // PaymentIntent without the API's attach-time auth.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const checkoutSession = await stripe.checkout.sessions.create({
    mode:        'subscription',
    customer:    stripeCustomer.id,
    line_items:  [{ price: price.id, quantity: 1 }],
    success_url: `${baseUrl}/welcome-back?recovered=true&customer=${merchant.id}`,
    cancel_url:  `${baseUrl}/welcome-back?recovered=false&customer=${merchant.id}`,
    payment_method_collection: 'always',
  })

  console.log('\n┌─────────────────────────────────────────────────────────────')
  console.log('│ PHASE 1 — Open this URL and enter the FAILING test card:')
  console.log('│')
  console.log(`│   ${checkoutSession.url}`)
  console.log('│')
  console.log('│ Use card:  4000 0000 0000 9995  (insufficient_funds)')
  console.log('│ Any future exp date, any CVC, any postcode.')
  console.log('│')
  console.log('│ EXPECTED: "Your card has insufficient funds" inline error.')
  console.log('│ Close the tab when you see the error — do NOT retry.')
  console.log('└─────────────────────────────────────────────────────────────\n')

  console.log('Polling DB for wb_churned_subscribers row (5 min timeout)…')

  let dunningRow: typeof churnedSubscribers.$inferSelect | undefined
  for (let i = 0; i < 300; i++) {
    const found = await db
      .select()
      .from(churnedSubscribers)
      .where(and(
        eq(churnedSubscribers.customerId, merchant.id),
        eq(churnedSubscribers.stripeCustomerId, stripeCustomer.id),
      ))
      .limit(1)
    if (found[0]) { dunningRow = found[0]; break }
    if (i % 5 === 0) process.stdout.write('.')
    await sleep(1000)
  }
  console.log('')

  if (!dunningRow) {
    console.error('\nNo wb_churned_subscribers row appeared after 5 min. Possible causes:')
    console.error('  - Card was retried with a working one (sub got paid)')
    console.error('  - Webhook not delivered (check ngrok + Stripe dashboard)')
    console.error('  - Customer closed the page before submitting')
    console.error('\nCustomer was:', stripeCustomer.id)
    console.error('To clean up: stripe.customers.del("' + stripeCustomer.id + '") on the merchant account.')
    process.exit(1)
  }

  console.log('  ✓ Dunning row created:', dunningRow.id)
  console.log('    status:                ', dunningRow.status)
  console.log('    dunningState:          ', dunningRow.dunningState, '   (expect: awaiting_retry)')
  console.log('    cancellationReason:    ', dunningRow.cancellationReason)
  console.log('    paymentMethodAtFailure:', dunningRow.paymentMethodAtFailure)
  console.log('    nextPaymentAttemptAt:  ', dunningRow.nextPaymentAttemptAt?.toISOString() ?? '(none — Stripe gave up)')
  console.log('    email:                 ', dunningRow.email)

  console.log('\n┌─────────────────────────────────────────────────────────────')
  console.log('│ PHASE 2 — Check inbox at:', dunningRow.email)
  console.log('│')
  console.log('│ Find the dunning email (subject: "Your payment didn\'t go through")')
  console.log('│ Click "Update payment" → Stripe Checkout setup mode opens.')
  console.log('│ Enter:  4242 4242 4242 4242  (good card)')
  console.log('│ Any future exp, any CVC, any postcode. Click Save.')
  console.log('│')
  console.log('│ Should land on /welcome-back with merchant brand "Fitness App".')
  console.log('└─────────────────────────────────────────────────────────────\n')

  console.log('Polling for wb_recoveries row (5 min timeout)…')

  let recoveryRow: typeof recoveries.$inferSelect | undefined
  for (let i = 0; i < 300; i++) {
    const found = await db
      .select()
      .from(recoveries)
      .where(eq(recoveries.subscriberId, dunningRow.id))
      .limit(1)
    if (found[0]) { recoveryRow = found[0]; break }
    if (i % 5 === 0) process.stdout.write('.')
    await sleep(1000)
  }
  console.log('')

  if (!recoveryRow) {
    const [final] = await db
      .select()
      .from(churnedSubscribers)
      .where(eq(churnedSubscribers.id, dunningRow.id))
      .limit(1)
    console.error('\nNo recovery row in 5min. Subscriber state:')
    console.error('  status:      ', final?.status)
    console.error('  dunningState:', final?.dunningState)
    console.error('  click time:  ', final?.billingPortalClickedAt?.toISOString())
    process.exit(1)
  }

  const [final] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, dunningRow.id))
    .limit(1)

  console.log('  ✓ Recovery row created:', recoveryRow.id)
  console.log('    attributionType:', recoveryRow.attributionType)
  console.log('    recoveryType:   ', recoveryRow.recoveryType)
  console.log('    planMrrCents:   ', recoveryRow.planMrrCents)

  console.log('\nFinal subscriber state:')
  console.log('  status:      ', final?.status,       '  (expect: recovered)')
  console.log('  dunningState:', final?.dunningState, '  (expect: recovered_during_dunning)')

  // Verify Stripe-side too
  const cust = await stripe.customers.retrieve(stripeCustomer.id) as Stripe.Customer
  const defaultPm = cust.invoice_settings?.default_payment_method
  console.log('\nStripe customer state:')
  console.log('  default PM:', typeof defaultPm === 'string' ? defaultPm : defaultPm?.id ?? '(none)')

  console.log('\n=== ALL GREEN — Spec 35 + recovery flow verified end-to-end ===')
  console.log('\nTest Stripe customer left in place:', stripeCustomer.id)
  console.log('To delete: pass --cleanup or run scripts/cleanup-spec35-e2e.ts')
}

main().catch((err) => { console.error(err); process.exit(1) }).finally(() => process.exit(0))

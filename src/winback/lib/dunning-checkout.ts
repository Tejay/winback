/**
 * Spec 35 — Stripe Checkout Session for update-payment.
 *
 * Handles `checkout.session.completed` events whose metadata flags them as
 * `winback_flow: 'dunning_update_payment'` — the customer just completed
 * the setup-mode Checkout we redirected them to from a dunning email.
 *
 * Steps:
 *   1. Resolve the subscriber + customer rows
 *   2. Pull the new payment method off the SetupIntent
 *   3. Attach it as the customer's default for future invoices
 *   4. Retry any open failed invoices for this subscription server-side
 *      (Stripe will fire invoice.payment_succeeded → existing recovery
 *       flow records attribution and clears dunning state)
 *
 * The actual recovery row is NOT written here — keeping write-once
 * semantics with `processPaymentSucceeded` avoids attribution drift.
 */
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from './encryption'
import { logEvent } from './events'

export async function processDunningPaymentUpdate(event: Stripe.Event): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session
  const subscriberId = session.metadata?.winback_subscriber_id
  const customerId   = session.metadata?.winback_customer_id

  if (!subscriberId || !customerId) return

  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!subscriber) return
  if (!subscriber.stripeCustomerId) return

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)

  if (!customer?.stripeAccessToken) return

  const accessToken = decrypt(customer.stripeAccessToken)
  const stripe = new Stripe(accessToken)

  // Resolve the SetupIntent and the new payment method ID.
  const setupIntentId = typeof session.setup_intent === 'string'
    ? session.setup_intent
    : session.setup_intent?.id ?? null

  if (!setupIntentId) {
    console.warn('[dunning-update-payment] no setup_intent on session:', session.id)
    return
  }

  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId)
  const paymentMethodId = typeof setupIntent.payment_method === 'string'
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id ?? null

  if (!paymentMethodId) {
    console.warn('[dunning-update-payment] no payment_method on setup_intent:', setupIntentId)
    return
  }

  // Attach as default for future invoices on this customer.
  await stripe.customers.update(subscriber.stripeCustomerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  })

  // Find any open failed invoices for this subscription and retry them
  // server-side. Stripe will fire invoice.payment_succeeded on success
  // → existing processPaymentSucceeded flow handles attribution.
  let retried = 0
  let retryFailures = 0
  if (subscriber.stripeSubscriptionId) {
    const invoices = await stripe.invoices.list({
      customer:     subscriber.stripeCustomerId,
      subscription: subscriber.stripeSubscriptionId,
      status:       'open',
      limit:        5,
    })

    // Oldest first — keeps the customer's invoice timeline ordered if
    // multiple were open.
    const ordered = [...invoices.data].sort(
      (a, b) => (a.created ?? 0) - (b.created ?? 0),
    )

    for (const inv of ordered) {
      if (!inv.id) continue
      try {
        await stripe.invoices.pay(inv.id)
        retried++
      } catch (err) {
        retryFailures++
        console.error('[dunning-update-payment] invoices.pay failed for', inv.id, err)
        // Genuine decline even with the new card — Stripe will retry on
        // its scheduled cadence; T2/T3 still fire if relevant.
      }
    }
  }

  await logEvent({
    name: 'dunning_payment_method_updated',
    customerId,
    properties: {
      subscriberId,
      paymentMethodId,
      invoicesRetried: retried,
      retryFailures,
    },
  })

  console.log(
    '[dunning-update-payment] subscriber=', subscriberId,
    'pm=',                                  paymentMethodId,
    'retried=',                             retried,
    'failures=',                            retryFailures,
  )
}

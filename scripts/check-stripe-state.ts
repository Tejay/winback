// Diagnose: what does Stripe actually say about the test subscriber's
// subscription + invoices? Compares to what our DB believes.
//
// Run with: npx tsx --env-file=.env.local scripts/check-stripe-state.ts
import { db } from '../lib/db'
import { customers, churnedSubscribers } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

const SUBSCRIBER_ID = '38a705a6-3290-44e9-9971-193a7973d940'

async function main() {
  const [sub] = await db.select().from(churnedSubscribers).where(eq(churnedSubscribers.id, SUBSCRIBER_ID)).limit(1)
  if (!sub) { console.error('subscriber row not found'); process.exit(1) }

  const [c] = await db.select().from(customers).where(eq(customers.id, sub.customerId)).limit(1)
  if (!c?.stripeAccessToken) { console.error('no access token'); process.exit(1) }

  console.log('=== DB row ===')
  console.log({
    id:                   sub.id,
    status:               sub.status,
    dunningState:         sub.dunningState,
    dunningTouchCount:    sub.dunningTouchCount,
    stripeCustomerId:     sub.stripeCustomerId,
    stripeSubscriptionId: sub.stripeSubscriptionId,
    paymentMethodAtFailure: sub.paymentMethodAtFailure,
  })

  const stripe = new Stripe(decrypt(c.stripeAccessToken))

  console.log('\n=== Stripe customer ===')
  try {
    const cust = await stripe.customers.retrieve(sub.stripeCustomerId) as Stripe.Customer
    const defaultPm = cust.invoice_settings?.default_payment_method
    console.log({
      id: cust.id,
      email: cust.email,
      defaultPaymentMethod: typeof defaultPm === 'string' ? defaultPm : defaultPm?.id ?? null,
    })
  } catch (e) {
    console.log('  retrieve failed:', e instanceof Error ? e.message : e)
  }

  console.log('\n=== Stripe subscription ===')
  if (!sub.stripeSubscriptionId) {
    console.log('  (no subscription id on the row)')
  } else {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId) as any
      console.log({
        id:                   s.id,
        status:               s.status,
        cancelAtPeriodEnd:    s.cancel_at_period_end,
        currentPeriodEnd:     new Date((s.current_period_end ?? 0) * 1000).toISOString(),
        latestInvoice:        typeof s.latest_invoice === 'string' ? s.latest_invoice : s.latest_invoice?.id,
        defaultPaymentMethod: typeof s.default_payment_method === 'string'
          ? s.default_payment_method
          : s.default_payment_method?.id ?? null,
      })
    } catch (e) {
      console.log('  retrieve failed:', e instanceof Error ? e.message : e)
    }
  }

  console.log('\n=== Open / past_due invoices for this customer ===')
  try {
    const invs = await stripe.invoices.list({
      customer: sub.stripeCustomerId,
      limit:    10,
    })
    for (const inv of invs.data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const i = inv as any
      console.log({
        id:                 i.id,
        status:             i.status,
        attemptCount:       i.attempt_count,
        nextPaymentAttempt: i.next_payment_attempt
          ? new Date(i.next_payment_attempt * 1000).toISOString()
          : null,
        subscription:       typeof i.subscription === 'string' ? i.subscription : i.subscription?.id ?? null,
        amountDue:          i.amount_due,
        currency:           i.currency,
      })
    }
    if (invs.data.length === 0) console.log('  (none)')
  } catch (e) {
    console.log('  list failed:', e instanceof Error ? e.message : e)
  }
}

main().catch((err) => { console.error(err); process.exit(1) }).finally(() => process.exit(0))

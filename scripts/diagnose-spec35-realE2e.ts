// Diagnose: did the failing card actually fail on Stripe?
import { db } from '../lib/db'
import { customers } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

async function main() {
  const [m] = await db.select().from(customers)
    .where(eq(customers.id, '609356c6-212a-4062-967e-fc0ae1f92600')).limit(1)
  if (!m?.stripeAccessToken) return
  const stripe = new Stripe(decrypt(m.stripeAccessToken))

  const cust = 'cus_UQVxm6zoBUS8zt'

  console.log('=== Subscriptions for', cust)
  const subs = await stripe.subscriptions.list({ customer: cust, status: 'all', limit: 5 })
  for (const s of subs.data) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sa = s as any
    console.log({
      id:                  s.id,
      status:              s.status,
      latestInvoice:       typeof s.latest_invoice === 'string' ? s.latest_invoice : s.latest_invoice?.id,
      created:             new Date(s.created * 1000).toISOString(),
      cancelAtPeriodEnd:   sa.cancel_at_period_end,
      pendingSetupIntent:  sa.pending_setup_intent,
    })
  }
  if (subs.data.length === 0) console.log('  (no subscriptions)')

  console.log('\n=== Invoices for', cust)
  const invs = await stripe.invoices.list({ customer: cust, limit: 10 })
  for (const inv of invs.data) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const i = inv as any
    console.log({
      id:                 i.id,
      status:             i.status,
      attemptCount:       i.attempt_count,
      subscription:       typeof i.subscription === 'string' ? i.subscription : i.subscription?.id ?? null,
      lastPaymentError:   i.last_finalization_error?.message ?? i.last_payment_error?.message,
      amountDue:          i.amount_due,
      created:            new Date(i.created * 1000).toISOString(),
    })
  }
  if (invs.data.length === 0) console.log('  (no invoices)')

  console.log('\n=== Recent webhook events on this account ===')
  const events = await stripe.events.list({ limit: 10, types: ['invoice.payment_failed', 'invoice.payment_succeeded', 'customer.subscription.created', 'checkout.session.completed'] })
  for (const ev of events.data) {
    console.log({
      type:    ev.type,
      created: new Date(ev.created * 1000).toISOString(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      object:  (ev.data.object as any).id ?? '?',
    })
  }
}
main().catch(console.error).finally(() => process.exit(0))

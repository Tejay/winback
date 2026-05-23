/**
 * Inspects the platform Stripe customer associated with a wb_customer
 * row — lists subscriptions, payment methods, default PM. Read-only.
 *
 *   tsx --env-file=.env.local scripts/inspect-platform-stripe-customer.ts <email>
 */

import { db } from '@/lib/db'
import { customers, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getPlatformStripe } from '../src/winback/lib/platform-stripe'

async function main(): Promise<void> {
  const email = process.argv[2] ?? 'tejaasvi@gmail.com'
  const [row] = await db
    .select({
      id: customers.id,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
      stripeSubscriptionId: customers.stripeSubscriptionId,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(users.email, email))
    .limit(1)
  if (!row) {
    console.error('no customer for', email)
    process.exit(1)
  }
  console.log('wb_customer:', row.id)
  console.log('platform stripe customer:', row.stripePlatformCustomerId)
  console.log('platform stripe subscription:', row.stripeSubscriptionId)
  console.log('')

  if (!row.stripePlatformCustomerId) {
    console.log('(no platform Stripe customer record)')
    return
  }

  const stripe = getPlatformStripe()
  const cust = await stripe.customers.retrieve(row.stripePlatformCustomerId)
  console.log('--- platform Stripe customer ---')
  console.log(JSON.stringify(cust, null, 2).split('\n').slice(0, 30).join('\n'))
  console.log('')

  const subs = await stripe.subscriptions.list({ customer: row.stripePlatformCustomerId, status: 'all', limit: 10 })
  console.log(`--- subscriptions (${subs.data.length}) ---`)
  for (const s of subs.data) {
    console.log(`  ${s.id}  status=${s.status}  cancel_at_period_end=${s.cancel_at_period_end}  current price=${s.items.data[0]?.price?.id}`)
  }
  console.log('')

  const pms = await stripe.paymentMethods.list({ customer: row.stripePlatformCustomerId, type: 'card', limit: 10 })
  console.log(`--- payment methods (${pms.data.length}) ---`)
  for (const pm of pms.data) {
    console.log(`  ${pm.id}  brand=${pm.card?.brand}  last4=${pm.card?.last4}  exp=${pm.card?.exp_month}/${pm.card?.exp_year}`)
  }
}

main().catch((err) => { console.error('failed', err); process.exit(1) })

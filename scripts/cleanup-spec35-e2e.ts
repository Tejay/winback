// Clean up the orphan test customer left by failed e2e attempts.
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

  const list = await stripe.customers.list({ email: 'tejaasvi+spec35e2e@gmail.com', limit: 5 })
  for (const c of list.data) {
    console.log('deleting', c.id)
    await stripe.customers.del(c.id)
  }
  console.log('done.')
}
main().catch(console.error).finally(() => process.exit(0))

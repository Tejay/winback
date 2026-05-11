// Delete all `billing-test-*@example.com` customers on tejaasvi's Connect
// Stripe account. Cancels their subscriptions implicitly (deleting a Stripe
// customer terminates dependents).
// Run: npx tsx --env-file=.env.local scripts/billing-test-cleanup-connect.ts [--dryRun]

import { db } from '../lib/db'
import { customers, users } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

const DRY = process.argv.includes('--dryRun')

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c?.stripeAccessToken) { console.error('no Connect token'); process.exit(1) }

  const connect = new Stripe(decrypt(c.stripeAccessToken))

  // Stripe customers.list supports email filter, but only exact match.
  // Use search for prefix-style queries.
  let toDelete: Stripe.Customer[] = []
  const search = await connect.customers.search({
    query: `email~'billing-test-'`,
    limit: 100,
  }).catch(() => null)

  if (search?.data?.length) {
    toDelete = search.data
  } else {
    // Fallback: list all and filter client-side
    const all = await connect.customers.list({ limit: 100 })
    toDelete = all.data.filter(x => x.email?.startsWith('billing-test-'))
  }

  console.log(`Found ${toDelete.length} test customer(s) on Connect (dryRun=${DRY})`)
  for (const cust of toDelete) {
    console.log(`  ${cust.id}  ${cust.email}  created=${new Date(cust.created*1000).toISOString()}`)
    if (!DRY) await connect.customers.del(cust.id)
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

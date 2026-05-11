// Are two Winback customers connected to the same Stripe Connect account?
// Read-only.
// Run: npx tsx --env-file=.env.local scripts/billing-test-check-collision.ts

import { db } from '../lib/db'
import { customers, users } from '../lib/schema'
import { eq, isNotNull, sql } from 'drizzle-orm'

async function main() {
  const rows = await db
    .select({
      email: users.email,
      customerId: customers.id,
      stripeAccountId: customers.stripeAccountId,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(isNotNull(customers.stripeAccountId))

  console.log(`Founders with stripeAccountId set:\n`)
  const byAccount = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = r.stripeAccountId ?? '(null)'
    if (!byAccount.has(key)) byAccount.set(key, [])
    byAccount.get(key)!.push(r)
  }
  for (const [acctId, list] of byAccount.entries()) {
    console.log(`Stripe Connect ${acctId}:`)
    for (const r of list) console.log(`  ${r.email}  customerId=${r.customerId}`)
    if (list.length > 1) console.log('  ⚠️ COLLISION — multiple Winback founders connected to same Stripe account')
    console.log()
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

/**
 * Real MRR snapshot for one customer. Lets us exercise the live Stripe
 * MRR computation without writing snapshots for all 5 connected accounts
 * (which the production cron would do).
 *
 *   tsx --env-file=.env.local scripts/snapshot-single-customer.ts <email>
 */

import { db } from '@/lib/db'
import { customers, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { takeSnapshot } from '../src/winback/lib/mrr-snapshot'
import { evaluateTransitionsForCustomer } from '../src/winback/lib/tier-transitions'

async function main(): Promise<void> {
  const email = process.argv[2] ?? 'tejaasvi@gmail.com'
  const [row] = await db
    .select({ id: customers.id, founderName: customers.founderName })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(users.email, email))
    .limit(1)
  if (!row) {
    console.error(`no customer for ${email}`)
    process.exit(1)
  }
  console.log(`customer: ${row.id} (${row.founderName ?? 'no name'})`)
  console.log('')
  console.log('takeSnapshot:')
  const snap = await takeSnapshot(row.id, 'weekly_cron')
  console.log(JSON.stringify(snap, null, 2))
  console.log('')
  console.log('evaluateTransitionsForCustomer:')
  const evalResult = await evaluateTransitionsForCustomer(row.id)
  console.log(JSON.stringify(evalResult, null, 2))
}

main().catch((err) => {
  console.error('failed', err)
  process.exit(1)
})

/**
 * Exercises prepareActivation against a real customer. Same code path
 * the /billing/activate page hits — without needing browser auth.
 *
 *   tsx --env-file=.env.local scripts/test-prepare-activation.ts <email>
 */

import { db } from '@/lib/db'
import { customers, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { prepareActivation } from '../src/winback/lib/activation'

async function main(): Promise<void> {
  const email = process.argv[2] ?? 'tejaasvi@gmail.com'
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(users.email, email))
    .limit(1)
  if (!row) {
    console.error(`no customer for ${email}`)
    process.exit(1)
  }
  const result = await prepareActivation(row.id)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('failed', err)
  process.exit(1)
})

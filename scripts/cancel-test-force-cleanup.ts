// One-off — clears wb_recoveries rows blocking cleanup of the cancel-test
// subscriber, then deletes the subscriber row and the Stripe customer.
import 'dotenv/config'
import Stripe from 'stripe'
import { eq } from 'drizzle-orm'
import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, users } from '../lib/schema'
import { decrypt } from '../src/winback/lib/encryption'

const MERCHANT_USER_EMAIL = 'tejaasvi@gmail.com'
const TEST_SUB_EMAIL      = 'tejaasvi+canceltest@gmail.com'

async function main(): Promise<void> {
  const rows = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.email, TEST_SUB_EMAIL))
  console.log(`Found ${rows.length} subscriber row(s) to wipe`)
  for (const r of rows) {
    const recs = await db.delete(recoveries).where(eq(recoveries.subscriberId, r.id)).returning({ id: recoveries.id })
    console.log(`  ${r.id}: deleted ${recs.length} recoveries row(s)`)
    await db.delete(churnedSubscribers).where(eq(churnedSubscribers.id, r.id))
    console.log(`  ${r.id}: deleted subscriber`)
  }

  const [merchant] = await db
    .select({ tok: customers.stripeAccessToken })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(users.email, MERCHANT_USER_EMAIL))
    .limit(1)
  if (merchant?.tok) {
    const stripe = new Stripe(decrypt(merchant.tok))
    const list = await stripe.customers.list({ email: TEST_SUB_EMAIL, limit: 20 })
    for (const c of list.data) {
      try {
        await stripe.customers.del(c.id)
        console.log(`  deleted Stripe customer ${c.id}`)
      } catch (e) {
        console.log(`  skip Stripe ${c.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => process.exit(0))

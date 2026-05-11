// Whose Stripe Connect account is currently linked to tejaasvi@gmail.com's Winback?
// Read-only.
// Run: npx tsx --env-file=.env.local scripts/billing-test-whose-connect.ts

import { db } from '../lib/db'
import { customers, users } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '../src/winback/lib/encryption'
import Stripe from 'stripe'

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  const [c] = await db.select().from(customers).where(eq(customers.userId, u!.id)).limit(1)
  if (!c?.stripeAccessToken) { console.error('no Connect token'); process.exit(1) }

  if (!c.stripeAccountId) { console.error('no stripeAccountId on customer row'); process.exit(1) }
  const connect = new Stripe(decrypt(c.stripeAccessToken))
  const acct = await connect.accounts.retrieve(c.stripeAccountId)
  console.log('Connect account on tejaasvi@gmail.com Winback:')
  console.log({
    id: acct.id,
    email: acct.email,
    business_profile_name: acct.business_profile?.name,
    country: acct.country,
    type: acct.type,
    charges_enabled: acct.charges_enabled,
    details_submitted: acct.details_submitted,
  })
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

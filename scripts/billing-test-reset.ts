// Reset tejaasvi@gmail.com to a pre-first-recovery baseline for billing tests.
//
// Idempotent + re-runnable. Hard-coded target email — refuses to operate on
// anyone else. Keeps:
//   - the users row
//   - the customers row + Stripe Connect access token
//   - changelog text + founder name
// Resets:
//   - activatedAt, stripeSubscriptionId, stripeSubscriptionCreatingAt,
//     pausedAt, pausedDunningAt, stripePlatformCustomerId
// Deletes:
//   - all churnedSubscribers + recoveries rows for this customer
// Cancels:
//   - any active/trialing subscription on Winback's platform Stripe under
//     stripePlatformCustomerId (and any other platform subs found by email)
//
// Pass --dryRun to print what would happen without changing anything.
// Run: npx tsx --env-file=.env.local scripts/billing-test-reset.ts [--dryRun]

import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, users, wbEvents, emailsSent } from '../lib/schema'
import { eq, inArray, and } from 'drizzle-orm'
import Stripe from 'stripe'
import { decrypt } from '../src/winback/lib/encryption'

const TARGET_EMAIL = 'tejaasvi@gmail.com'
const DRY = process.argv.includes('--dryRun')

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, TARGET_EMAIL)).limit(1)
  if (!u) { console.error(`user ${TARGET_EMAIL} not found`); process.exit(1) }
  const [c] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) { console.error(`customer for ${TARGET_EMAIL} not found`); process.exit(1) }

  console.log(`Target: ${TARGET_EMAIL}  customerId=${c.id}  dryRun=${DRY}`)

  // 1) Platform Stripe — cancel any subscription on this customer
  const platformStripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
  const platformCustomerIds = new Set<string>()
  if (c.stripePlatformCustomerId) platformCustomerIds.add(c.stripePlatformCustomerId)

  // Also search by email — older test runs may have leaked stray customers
  const byEmail = await platformStripe.customers.list({ email: TARGET_EMAIL, limit: 20 })
  for (const pc of byEmail.data) platformCustomerIds.add(pc.id)

  console.log(`\n[1/3] Platform Stripe — found ${platformCustomerIds.size} customer(s) by email/id`)
  for (const pcId of platformCustomerIds) {
    const subs = await platformStripe.subscriptions.list({ customer: pcId, status: 'all', limit: 20 })
    for (const s of subs.data) {
      if (s.status === 'active' || s.status === 'trialing' || s.status === 'past_due') {
        console.log(`  cancel sub ${s.id} (status=${s.status}, customer=${pcId})`)
        if (!DRY) await platformStripe.subscriptions.cancel(s.id)
      } else {
        console.log(`  skip sub ${s.id} (status=${s.status}) — already terminal`)
      }
    }
  }

  // 1.5) Connect Stripe — delete any billing-test-* customers so retry
  // webhooks from previous runs don't land after we've reset the DB.
  if (c.stripeAccessToken) {
    const connect = new Stripe(decrypt(c.stripeAccessToken))
    const search = await connect.customers.search({
      query: `email~'billing-test-'`,
      limit: 100,
    }).catch(() => null)
    const stale = search?.data ?? []
    console.log(`\n[1.5/3] Connect Stripe — ${stale.length} billing-test-* customer(s) to delete`)
    for (const cust of stale) {
      console.log(`  ${cust.id}  ${cust.email}`)
      if (!DRY) await connect.customers.del(cust.id)
    }
  }

  // 2) DB — delete events + emails_sent + recoveries + subscribers (in that order)
  const subsToDel = await db.select({ id: churnedSubscribers.id }).from(churnedSubscribers).where(eq(churnedSubscribers.customerId, c.id))
  const subIds = subsToDel.map(s => s.id)
  const recsToDel = await db.select({ id: recoveries.id }).from(recoveries).where(eq(recoveries.customerId, c.id))
  const eventsToDel = await db.select({ id: wbEvents.id }).from(wbEvents).where(eq(wbEvents.customerId, c.id))
  const emailsToDel = subIds.length > 0
    ? await db.select({ id: emailsSent.id }).from(emailsSent).where(inArray(emailsSent.subscriberId, subIds))
    : []
  console.log(`\n[2/3] DB cleanup — events=${eventsToDel.length} emails_sent=${emailsToDel.length} recoveries=${recsToDel.length} subscribers=${subsToDel.length}`)
  if (!DRY) {
    if (eventsToDel.length > 0) await db.delete(wbEvents).where(eq(wbEvents.customerId, c.id))
    if (subIds.length > 0) await db.delete(emailsSent).where(inArray(emailsSent.subscriberId, subIds))
    if (recsToDel.length > 0) await db.delete(recoveries).where(eq(recoveries.customerId, c.id))
    if (subsToDel.length > 0) await db.delete(churnedSubscribers).where(eq(churnedSubscribers.customerId, c.id))
  }

  // 3) DB — null out billing-state columns on the customer
  console.log(`\n[3/3] DB reset — customer billing columns`)
  console.log(`  before: activatedAt=${c.activatedAt?.toISOString() ?? 'NULL'} subId=${c.stripeSubscriptionId ?? 'NULL'} platformCustomer=${c.stripePlatformCustomerId ?? 'NULL'}`)
  if (!DRY) {
    await db.update(customers)
      .set({
        activatedAt: null,
        stripeSubscriptionId: null,
        stripeSubscriptionCreatingAt: null,
        pausedAt: null,
        pausedDunningAt: null,
        stripePlatformCustomerId: null,
      })
      .where(eq(customers.id, c.id))
  }

  // Verify
  const [after] = await db.select().from(customers).where(eq(customers.id, c.id)).limit(1)
  const recsLeft = await db.select({ id: recoveries.id }).from(recoveries).where(eq(recoveries.customerId, c.id))
  const subsLeft = await db.select({ id: churnedSubscribers.id }).from(churnedSubscribers).where(eq(churnedSubscribers.customerId, c.id))
  console.log(`\n=== Verified post-reset ===`)
  console.log(`  activatedAt=${after.activatedAt?.toISOString() ?? 'NULL'}`)
  console.log(`  stripeSubscriptionId=${after.stripeSubscriptionId ?? 'NULL'}`)
  console.log(`  stripeSubscriptionCreatingAt=${after.stripeSubscriptionCreatingAt?.toISOString() ?? 'NULL'}`)
  console.log(`  pausedAt=${after.pausedAt?.toISOString() ?? 'NULL'}`)
  console.log(`  pausedDunningAt=${after.pausedDunningAt?.toISOString() ?? 'NULL'}`)
  console.log(`  stripePlatformCustomerId=${after.stripePlatformCustomerId ?? 'NULL'}`)
  console.log(`  stripeAccessToken=${after.stripeAccessToken ? '(kept)' : 'NULL'}`)
  console.log(`  recoveries=${recsLeft.length}  churnedSubscribers=${subsLeft.length}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

// Inventory test founders + their billing state. Read-only.
// Run: npx tsx --env-file=.env.local scripts/billing-test-inventory.ts
import { db } from '../lib/db'
import { customers, churnedSubscribers, recoveries, users } from '../lib/schema'
import { eq, sql } from 'drizzle-orm'

async function main() {
  const rows = await db
    .select({
      userEmail: users.email,
      founderName: customers.founderName,
      customerId: customers.id,
      stripeConnected: sql<boolean>`${customers.stripeAccessToken} IS NOT NULL`,
      activatedAt: customers.activatedAt,
      stripeSubscriptionId: customers.stripeSubscriptionId,
      stripeCreatingAt: customers.stripeSubscriptionCreatingAt,
      pausedAt: customers.pausedAt,
      pausedDunningAt: customers.pausedDunningAt,
      pilotUntil: customers.pilotUntil,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .orderBy(users.email)

  console.log(`\nTotal founders: ${rows.length}\n`)
  for (const r of rows) {
    const subCount = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(churnedSubscribers)
      .where(eq(churnedSubscribers.customerId, r.customerId))
    const recCount = await db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(recoveries)
      .where(eq(recoveries.customerId, r.customerId))

    console.log(`• ${r.userEmail}`)
    console.log(`    founder=${r.founderName ?? '(none)'} customerId=${r.customerId}`)
    console.log(`    stripeConnected=${r.stripeConnected}  activatedAt=${r.activatedAt?.toISOString() ?? 'NULL'}`)
    console.log(`    stripeSubscriptionId=${r.stripeSubscriptionId ?? 'NULL'}  creatingAt=${r.stripeCreatingAt?.toISOString() ?? 'NULL'}`)
    console.log(`    pausedWinback=${r.pausedAt?.toISOString() ?? 'NULL'}  pausedDunning=${r.pausedDunningAt?.toISOString() ?? 'NULL'}`)
    console.log(`    pilotUntil=${r.pilotUntil?.toISOString() ?? 'NULL'}`)
    console.log(`    subscribers=${subCount[0].n}  recoveries=${recCount[0].n}`)
    console.log()
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

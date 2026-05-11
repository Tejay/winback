// Spec 56 — Find Winback customers that share a Stripe Connect account
// (illegal state once migration 036 lands) and propose a canonical owner.
//
// Run order:
//   1. npx tsx --env-file=.env.local scripts/spec-56-backfill-duplicates.ts --dryRun
//   2. (review the plan above with a human)
//   3. npx tsx --env-file=.env.local scripts/spec-56-backfill-duplicates.ts --apply
//   4. psql $DATABASE_URL -f src/winback/migrations/036_unique_stripe_account_id.sql
//
// Canonical-owner heuristic:
//   - Most recent `updated_at` wins ("most actively used" proxy)
//   - Tie-break: row with the most attached wb_churned_subscribers
//   - Final tie-break: lowest customer id (deterministic)
//
// For non-canonical rows: NULL stripe_account_id + stripe_access_token,
// set onboarding_complete = false. Existing wb_churned_subscribers tied
// to those rows are NOT moved — they remain orphaned on the row (no
// future webhooks will touch them because the link is broken).

import { db } from '../lib/db'
import { customers, churnedSubscribers, users } from '../lib/schema'
import { eq, isNotNull, sql, desc } from 'drizzle-orm'

const DRY = !process.argv.includes('--apply')

type Row = {
  customerId: string
  userId: string
  email: string
  stripeAccountId: string
  updatedAt: Date | null
  subCount: number
}

async function main() {
  console.log(`Spec 56 backfill — mode=${DRY ? 'DRY RUN' : 'APPLY'}\n`)

  // Find duplicate stripe_account_id sets
  const dupes = await db
    .select({
      stripeAccountId: customers.stripeAccountId,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(customers)
    .where(isNotNull(customers.stripeAccountId))
    .groupBy(customers.stripeAccountId)
    .having(sql`COUNT(*) > 1`)

  if (dupes.length === 0) {
    console.log('✓ No duplicate Stripe account links found. Safe to apply migration 036.')
    return
  }

  console.log(`Found ${dupes.length} Stripe account(s) shared by multiple Winback customers.\n`)

  for (const d of dupes) {
    const acctId = d.stripeAccountId!
    console.log(`Duplicate set: ${acctId}  (${d.n} rows)`)

    // Pull each row with its subscriber count
    const rowsRaw = await db
      .select({
        customerId: customers.id,
        userId: customers.userId,
        email: users.email,
        updatedAt: customers.updatedAt,
      })
      .from(customers)
      .innerJoin(users, eq(customers.userId, users.id))
      .where(eq(customers.stripeAccountId, acctId))
      .orderBy(desc(customers.updatedAt))

    const rows: Row[] = []
    for (const r of rowsRaw) {
      const [cnt] = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(churnedSubscribers)
        .where(eq(churnedSubscribers.customerId, r.customerId))
      rows.push({
        customerId: r.customerId,
        userId: r.userId,
        email: r.email,
        stripeAccountId: acctId,
        updatedAt: r.updatedAt,
        subCount: cnt.n,
      })
    }

    // Canonical = highest updatedAt; tie-break on subCount; final on customerId
    const sorted = rows.slice().sort((a, b) => {
      const at = (a.updatedAt?.getTime() ?? 0)
      const bt = (b.updatedAt?.getTime() ?? 0)
      if (at !== bt) return bt - at
      if (a.subCount !== b.subCount) return b.subCount - a.subCount
      return a.customerId.localeCompare(b.customerId)
    })
    const keep = sorted[0]
    const drop = sorted.slice(1)

    console.log(`  KEEP:  ${keep.email}  customerId=${keep.customerId}`)
    console.log(`         updatedAt=${keep.updatedAt?.toISOString() ?? 'NULL'}  subscribers=${keep.subCount}`)
    for (const r of drop) {
      console.log(`  CLEAR: ${r.email}  customerId=${r.customerId}`)
      console.log(`         updatedAt=${r.updatedAt?.toISOString() ?? 'NULL'}  subscribers=${r.subCount}`)
      console.log(`         → will NULL stripeAccountId + stripeAccessToken, set onboardingComplete=false`)
      if (r.subCount > 0) {
        console.log(`         NOTE: ${r.subCount} wb_churned_subscribers rows will remain orphaned on this customer`)
      }

      if (!DRY) {
        await db
          .update(customers)
          .set({
            stripeAccountId: null,
            stripeAccessToken: null,
            onboardingComplete: false,
            updatedAt: new Date(),
          })
          .where(eq(customers.id, r.customerId))
      }
    }
    console.log()
  }

  if (DRY) {
    console.log('---')
    console.log('Dry run — no changes applied. Re-run with --apply when you are happy with the plan.')
  } else {
    console.log('✓ Backfill applied. Next: apply migration 036.')
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

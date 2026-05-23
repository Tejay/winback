/**
 * Seeds a synthetic churned_subscriber + recovery row for a customer so
 * the activation flow can be tested end-to-end without waiting for a
 * real merchant-side Stripe recovery event.
 *
 * Strong-attribution win_back recovery of a $99/mo subscriber, recovered
 * just now. Idempotent — re-running creates additional rows (so don't
 * loop it).
 *
 *   tsx --env-file=.env.local scripts/seed-test-recovery.ts <email>
 */

import { db } from '@/lib/db'
import { customers, users, churnedSubscribers, recoveries } from '@/lib/schema'
import { eq } from 'drizzle-orm'

async function main(): Promise<void> {
  const email = process.argv[2] ?? 'tejaasvi@gmail.com'
  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(users.email, email))
    .limit(1)
  if (!row) {
    console.error('no customer for', email)
    process.exit(1)
  }

  const now = new Date()
  const cancelledAt = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const mrrCents = 9900

  const [sub] = await db
    .insert(churnedSubscribers)
    .values({
      customerId: row.id,
      stripeCustomerId: `cus_test_seed_${now.getTime()}`,
      stripeSubscriptionId: `sub_test_seed_${now.getTime()}`,
      email: 'test-recovered@example.com',
      name: 'Test Recovered Subscriber',
      planName: 'Pro plan',
      mrrCents,
      status: 'recovered',
      cancelledAt,
      classifiedAt: now,
      cancellationReason: 'Other',
    })
    .returning({ id: churnedSubscribers.id })

  const [rec] = await db
    .insert(recoveries)
    .values({
      subscriberId: sub.id,
      customerId: row.id,
      planMrrCents: mrrCents,
      attributionType: 'strong',
      recoveryType: 'win_back',
      recoveredAt: now,
    })
    .returning({ id: recoveries.id })

  console.log(`[seed] churned_subscriber: ${sub.id}`)
  console.log(`[seed] recovery:           ${rec.id}`)
  console.log(`[seed] ${email} now has 1 strong-attribution win_back recovery, MRR $${mrrCents / 100}`)
}

main().catch((err) => { console.error('failed', err); process.exit(1) })

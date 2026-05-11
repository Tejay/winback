// Spec 56 (prod side) — delete tejaasvi@gmail.com + tejaasvi+Verify1@gmail.com
// from production entirely. They are pre-launch test rows that collide on the
// same Stripe Connect account (acct_1TL2kE…) and are not the canonical prod
// test merchant (which is testfounder.winback@gmail.com, per CLAUDE.md).
//
// Safety: hard-coded email allowlist; refuses to operate on anything else.
// Run order:
//   1. Pull prod env: vercel env pull .env.production.tmp --environment=production
//   2. Bridge env:    npx tsx scripts/spec-56-bridge-prod-env.ts
//   3. Dry-run:       npx tsx --env-file=.env.production.tmp scripts/spec-56-prod-delete-test-rows.ts
//   4. Apply:         npx tsx --env-file=.env.production.tmp scripts/spec-56-prod-delete-test-rows.ts --apply
//   5. Clean up:      rm .env.production.tmp
//
// Cascade: deleting wb_users CASCADES to wb_customers → wb_churned_subscribers
// → wb_emails_sent + wb_events. BUT wb_recoveries has no ON DELETE so we
// must clear it explicitly first.

import { db } from '../lib/db'
import { users, customers, churnedSubscribers, recoveries, wbEvents, emailsSent } from '../lib/schema'
import { eq, inArray, sql } from 'drizzle-orm'

const TARGET_EMAILS = ['tejaasvi@gmail.com', 'tejaasvi+Verify1@gmail.com']
const DRY = !process.argv.includes('--apply')

async function main() {
  console.log(`Spec 56 prod test-row deletion — mode=${DRY ? 'DRY RUN' : 'APPLY'}`)
  console.log(`Target emails: ${TARGET_EMAILS.join(', ')}\n`)

  // Look up users and their customers
  const userRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, TARGET_EMAILS))

  if (userRows.length === 0) {
    console.log('No matching users found. Nothing to do.')
    return
  }

  const userIds = userRows.map(u => u.id)
  const custRows = await db
    .select({ id: customers.id, userId: customers.userId, stripeAccountId: customers.stripeAccountId })
    .from(customers)
    .where(inArray(customers.userId, userIds))
  const customerIds = custRows.map(c => c.id)

  // Count children for visibility
  const [csCount] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(churnedSubscribers).where(inArray(churnedSubscribers.customerId, customerIds))
  const [recCount] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(recoveries).where(inArray(recoveries.customerId, customerIds))
  const [eventCount] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(wbEvents).where(inArray(wbEvents.customerId, customerIds))

  const subscriberIds = csCount.n > 0
    ? (await db.select({ id: churnedSubscribers.id }).from(churnedSubscribers).where(inArray(churnedSubscribers.customerId, customerIds))).map(r => r.id)
    : []
  const [emailCount] = subscriberIds.length > 0
    ? await db.select({ n: sql<number>`COUNT(*)::int` }).from(emailsSent).where(inArray(emailsSent.subscriberId, subscriberIds))
    : [{ n: 0 }]

  for (const u of userRows) {
    const c = custRows.find(c => c.userId === u.id)
    console.log(`• ${u.email}`)
    console.log(`    userId=${u.id}`)
    console.log(`    customerId=${c?.id ?? '(none)'}  stripeAccountId=${c?.stripeAccountId ?? '(none)'}`)
  }
  console.log()
  console.log('Child-row totals (across both):')
  console.log(`  wb_customers           ${custRows.length}`)
  console.log(`  wb_churned_subscribers ${csCount.n}`)
  console.log(`  wb_recoveries          ${recCount.n}`)
  console.log(`  wb_events              ${eventCount.n}`)
  console.log(`  wb_emails_sent         ${emailCount.n}`)
  console.log()

  if (DRY) {
    console.log('Plan:')
    console.log('  1. DELETE FROM wb_recoveries WHERE customer_id IN (target customerIds)  -- (no ON DELETE)')
    console.log('  2. DELETE FROM wb_users WHERE id IN (target userIds)')
    console.log('     → cascades to wb_customers → wb_churned_subscribers → wb_emails_sent + wb_events')
    console.log('     → wb_legal_acceptances, wb_password_reset_tokens, wb_email_verification_tokens (cascade from user)')
    console.log('     → wb_pilot_tokens.usedByUserId / createdByUserId set NULL')
    console.log()
    console.log('Dry run — no changes applied. Re-run with --apply to execute.')
    return
  }

  // Apply order: recoveries first, then users (cascade handles the rest)
  if (recCount.n > 0) {
    console.log(`Deleting ${recCount.n} wb_recoveries rows...`)
    await db.delete(recoveries).where(inArray(recoveries.customerId, customerIds))
  }
  console.log(`Deleting ${userRows.length} wb_users rows (cascade)...`)
  await db.delete(users).where(inArray(users.id, userIds))

  console.log('\n=== Verification ===')
  const [usersLeft] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(users).where(inArray(users.email, TARGET_EMAILS))
  const [custLeft] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(customers).where(inArray(customers.id, customerIds))
  const [csLeft] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(churnedSubscribers).where(inArray(churnedSubscribers.customerId, customerIds))
  const [recLeft] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(recoveries).where(inArray(recoveries.customerId, customerIds))
  console.log(`  wb_users matching targets:    ${usersLeft.n}  (expect 0)`)
  console.log(`  wb_customers (by id):         ${custLeft.n}  (expect 0)`)
  console.log(`  wb_churned_subscribers:       ${csLeft.n}  (expect 0)`)
  console.log(`  wb_recoveries:                ${recLeft.n}  (expect 0)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e); process.exit(1) })

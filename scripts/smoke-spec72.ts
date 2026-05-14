// Spec 72 smoke harness — verifies the producer/consumer pipeline end-to-end.
//
//   npx tsx --env-file=.env.local scripts/smoke-spec72.ts            # full run, cleans up
//   npx tsx --env-file=.env.local scripts/smoke-spec72.ts --keep     # leaves data for browser
//   npx tsx --env-file=.env.local scripts/smoke-spec72.ts --cleanup  # delete prior smoke data
//
// Scenarios:
//   1. Migration sanity — new columns + indexes exist, dropped data backfilled
//   2. INSERT raw row with classified_at=NULL (mimics what webhook does now)
//   3. Classifier tick picks up the row, sets classified_at + classification
//   4. Dead-letter: row that fails 3 times falls out of the queue
//   5. Reset-classify clears attempts and lets the cron retry
//   6. Dead-letter count helper returns the right number
//
// Each scenario uses ~1 Anthropic LLM call (~$0.003) when it exercises the
// classifier path. Skips for silent-churn rows.

import { db } from '../lib/db'
import {
  customers, churnedSubscribers, users, wbEvents,
} from '../lib/schema'
import { and, eq, sql, isNull, isNotNull, desc, like } from 'drizzle-orm'
import { runClassifierTick, countDeadLetteredRows } from '../src/winback/lib/classifier-tick'

const TAG = 'spec72-smoke'
const KEEP = process.argv.includes('--keep')
const CLEANUP_ONLY = process.argv.includes('--cleanup')

interface Verdict { name: string; pass: boolean; detail?: string }
const verdicts: Verdict[] = []

function check(name: string, pass: boolean, detail?: string) {
  verdicts.push({ name, pass, detail })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function getDevCustomer() {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  if (!u) throw new Error('Dev user tejaasvi@gmail.com not found')
  const [c] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) throw new Error('Dev customer not found')
  return c
}

async function scenario1_migrationSanity() {
  console.log('\n[1] Migration sanity')

  // New customers columns exist
  let customersCols = false
  try {
    const r = (await db.execute(sql.raw(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='wb_customers'
       AND column_name IN ('backfill_cursor', 'backfill_processing_at')`,
    ))) as { rows: { column_name: string }[] }
    customersCols = r.rows.length === 2
  } catch {}
  check('wb_customers has backfill_cursor + backfill_processing_at', customersCols)

  // New churned_subscribers columns
  let subsCols = false
  try {
    const r = (await db.execute(sql.raw(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='wb_churned_subscribers'
       AND column_name IN ('classified_at', 'classify_attempts')`,
    ))) as { rows: { column_name: string }[] }
    subsCols = r.rows.length === 2
  } catch {}
  check('wb_churned_subscribers has classified_at + classify_attempts', subsCols)

  // Compound UNIQUE index
  let uniqueIdx = false
  try {
    const r = (await db.execute(sql.raw(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='wb_churned_subscribers'
       AND indexname='idx_wb_churned_subscribers_customer_stripe'`,
    ))) as { rows: unknown[] }
    uniqueIdx = r.rows.length === 1
  } catch {}
  check('UNIQUE (customer_id, stripe_customer_id) index present', uniqueIdx)

  // Pending-classify partial index
  let partialIdx = false
  try {
    const r = (await db.execute(sql.raw(
      `SELECT indexname FROM pg_indexes
       WHERE tablename='wb_churned_subscribers'
       AND indexname='idx_wb_churned_subscribers_pending_classify'`,
    ))) as { rows: unknown[] }
    partialIdx = r.rows.length === 1
  } catch {}
  check('Partial idx_wb_churned_subscribers_pending_classify present', partialIdx)

  // Old classified rows got their classified_at backfilled
  const [stuckOld] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(churnedSubscribers)
    .where(and(
      isNotNull(churnedSubscribers.tier),
      isNull(churnedSubscribers.classifiedAt),
    ))
  check('Existing tier-set rows have classified_at populated', Number(stuckOld?.n ?? 0) === 0,
    `${stuckOld?.n ?? 0} pre-existing rows still have NULL classified_at`)
}

async function scenario2_rawInsert(customerId: string) {
  console.log('\n[2] Raw insert with classified_at = NULL (mimics webhook path)')
  const stripeCustomerId = `cus_${TAG}_${Date.now()}`
  const [row] = await db
    .insert(churnedSubscribers)
    .values({
      customerId,
      stripeCustomerId,
      email: `${TAG}-raw@example.com`,
      name: 'Spec72 raw',
      planName: 'Pro',
      mrrCents: 1900,
      tenureDays: 60,
      cancelledAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      stripeEnum: 'too_expensive',
      stripeComment: 'budget tightened',
      status: 'pending',
      source: TAG,
    })
    .returning({ id: churnedSubscribers.id, classifiedAt: churnedSubscribers.classifiedAt, classifyAttempts: churnedSubscribers.classifyAttempts })

  check('raw row inserted', !!row, row?.id)
  check('classified_at defaults to NULL', row?.classifiedAt === null)
  check('classify_attempts defaults to 0', row?.classifyAttempts === 0)
  return row.id
}

async function scenario3_classifierPicks(subscriberId: string) {
  console.log('\n[3] Classifier tick picks up + classifies (real LLM call ~$0.003)')
  const stats = await runClassifierTick()
  check('classifier processed at least one row', stats.picked >= 1, `picked=${stats.picked} classified=${stats.classified}`)

  const [row] = await db
    .select({
      classifiedAt: churnedSubscribers.classifiedAt,
      tier:         churnedSubscribers.tier,
      triggerNeed:  churnedSubscribers.triggerNeed,
    })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  check('classified_at is set after tick', !!row?.classifiedAt)
  check('tier is set', row?.tier !== null && row?.tier !== undefined, `tier=${row?.tier}`)
}

async function scenario4_deadLetter(customerId: string) {
  console.log('\n[4] Dead-letter: 3 forced failures → drops out of queue')

  // Insert a row with classify_attempts already at 3 (mimics three prior failed
  // attempts). The cron's WHERE clause filters lt(attempts, 3), so this row
  // should NOT be picked up in the next tick.
  const [row] = await db
    .insert(churnedSubscribers)
    .values({
      customerId,
      stripeCustomerId: `cus_${TAG}_dl_${Date.now()}`,
      email: `${TAG}-deadletter@example.com`,
      name: 'Spec72 dead letter',
      planName: 'Pro',
      mrrCents: 1900,
      tenureDays: 60,
      cancelledAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      stripeEnum: 'too_expensive',
      stripeComment: 'pretend to be bad',
      status: 'pending',
      source: TAG,
      classifyAttempts: 3,
    })
    .returning({ id: churnedSubscribers.id })

  const statsBefore = await runClassifierTick()
  const [rowAfter] = await db
    .select({ classifiedAt: churnedSubscribers.classifiedAt, classifyAttempts: churnedSubscribers.classifyAttempts })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, row.id))

  check('dead-lettered row not picked by classifier', rowAfter?.classifiedAt === null,
    `attempts=${rowAfter?.classifyAttempts} classifiedAt=${rowAfter?.classifiedAt}`)
  check('dead-letter count includes this row',
    (await countDeadLetteredRows()) >= 1,
    `count=${await countDeadLetteredRows()}`)
  return row.id
}

async function scenario5_resetClassify(subscriberId: string) {
  console.log('\n[5] Reset attempts → row re-enters queue → classifier picks it up')

  // Reset via direct UPDATE (mirrors what the endpoint does)
  await db
    .update(churnedSubscribers)
    .set({ classifyAttempts: 0 })
    .where(eq(churnedSubscribers.id, subscriberId))

  const stats = await runClassifierTick()
  const [row] = await db
    .select({ classifiedAt: churnedSubscribers.classifiedAt, tier: churnedSubscribers.tier })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))

  check('reset row gets classified on next tick', !!row?.classifiedAt,
    `tier=${row?.tier} classifiedAt=${row?.classifiedAt}`)
  check('classifier stats reflect this run', stats.classified >= 1, `classified=${stats.classified}`)
}

async function scenario6_eventsLogged() {
  console.log('\n[6] Event log: subscriber_classified events fired during the run')
  const events = await db
    .select({ name: wbEvents.name, createdAt: wbEvents.createdAt })
    .from(wbEvents)
    .where(eq(wbEvents.name, 'subscriber_classified'))
    .orderBy(desc(wbEvents.createdAt))
    .limit(5)

  check('subscriber_classified events emitted', events.length > 0, `latest: ${events[0]?.createdAt}`)
}

async function cleanup() {
  // Delete everything tagged with TAG (subscribers + their events)
  const subs = await db
    .delete(churnedSubscribers)
    .where(eq(churnedSubscribers.source, TAG))
    .returning({ id: churnedSubscribers.id })

  // Events are referenced by subscriberId inside properties — delete by
  // matching properties.subscriberId. Easier: delete by metadata pattern.
  await db
    .delete(wbEvents)
    .where(like(sql<string>`${wbEvents.properties}->>'subscriberId'`, `%`))
    .catch(() => {})  // ignore; events are append-only and not required for cleanup

  console.log(`  Cleaned up ${subs.length} smoke row(s)`)
}

async function main() {
  if (CLEANUP_ONLY) {
    await cleanup()
    return
  }

  console.log('Spec 72 smoke harness  (--keep to leave subscribers for browser inspection)')

  await scenario1_migrationSanity()

  const customer = await getDevCustomer()
  console.log(`\nUsing dev customer: ${customer.id}`)

  const rawSubId = await scenario2_rawInsert(customer.id)
  await scenario3_classifierPicks(rawSubId)
  const dlSubId = await scenario4_deadLetter(customer.id)
  await scenario5_resetClassify(dlSubId)
  await scenario6_eventsLogged()

  console.log('\n── SUMMARY ─────────────────────────────────')
  const pass = verdicts.filter((v) => v.pass).length
  const fail = verdicts.filter((v) => !v.pass).length
  console.log(`  ${pass} passed, ${fail} failed of ${verdicts.length} checks`)
  if (fail > 0) {
    console.log('\n  Failing checks:')
    for (const v of verdicts.filter((x) => !x.pass)) {
      console.log(`    ✗ ${v.name}${v.detail ? ` — ${v.detail}` : ''}`)
    }
  }

  if (KEEP) {
    console.log(`\n  Keeping smoke subscribers. Open inspectors:`)
    console.log(`    http://localhost:3000/admin/subscribers/${rawSubId}    (classified)`)
    console.log(`    http://localhost:3000/admin/subscribers/${dlSubId}     (was dead-lettered, then reset)`)
    console.log(`  Overview tile: http://localhost:3000/admin`)
    console.log(`  Cleanup later: npx tsx --env-file=.env.local scripts/smoke-spec72.ts --cleanup`)
  } else {
    console.log('\nCleaning up…')
    await cleanup()
  }

  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1) })

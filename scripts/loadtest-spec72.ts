// Spec 72 load test — 1000 cancelled subscribers, ~10% signal-bearing.
//
//   npx tsx --env-file=.env.local scripts/loadtest-spec72.ts            # full run
//   npx tsx --env-file=.env.local scripts/loadtest-spec72.ts --cleanup  # delete only
//
// Mimics the real-world cohort: 100 of 1000 have stripeEnum/stripeComment
// (hit the LLM ~$0.003 each = ~$0.30 total), 900 are silent churn (skip
// LLM via hasSignalForLLM fast path; classified deterministically).
//
// All cancellations are 30 days old so the exit-email path doesn't fire
// (no real emails sent to @example.com test addresses).
//
// Reports per-tick throughput and end-to-end timing.

import { db } from '../lib/db'
import { customers, churnedSubscribers, users } from '../lib/schema'
import { eq, and, isNull, sql, count } from 'drizzle-orm'
import { runClassifierTick } from '../src/winback/lib/classifier-tick'

const TAG = 'loadtest72'
const TOTAL_ROWS = 1000
const SIGNAL_ROWS = 100               // 10% hit LLM
const OLD_CANCEL_DAYS = 30            // skips exit-email path entirely
const CLEANUP_ONLY = process.argv.includes('--cleanup')

async function getDevCustomer() {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  if (!u) throw new Error('Dev user not found')
  const [c] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) throw new Error('Dev customer not found')
  return c
}

async function cleanup() {
  console.log('Cleaning up loadtest rows…')
  const t0 = Date.now()
  const result = await db
    .delete(churnedSubscribers)
    .where(eq(churnedSubscribers.source, TAG))
  console.log(`  Done in ${Date.now() - t0}ms`)
  return result
}

async function seed(customerId: string) {
  console.log(`\nSeeding ${TOTAL_ROWS} rows (${SIGNAL_ROWS} with signal, ${TOTAL_ROWS - SIGNAL_ROWS} silent)…`)
  const t0 = Date.now()
  const cancelledAt = new Date(Date.now() - OLD_CANCEL_DAYS * 24 * 60 * 60 * 1000)

  const enums = ['too_expensive', 'missing_features', 'unused', 'switched_service', 'customer_service']
  const comments = [
    'Plan got too pricey for what we use',
    'Need Slack notifications which you don\'t have',
    'We stopped using the tool, no real reason',
    'Moved to Foo Corp which has bulk export',
    'Support was unresponsive when we hit a billing issue',
  ]

  // Insert in batches of 100 for speed
  const BATCH = 100
  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH) {
    const rows: typeof churnedSubscribers.$inferInsert[] = []
    for (let i = batchStart; i < batchStart + BATCH && i < TOTAL_ROWS; i++) {
      const hasSignal = i < SIGNAL_ROWS
      const enumIdx = i % enums.length
      rows.push({
        customerId,
        stripeCustomerId: `cus_${TAG}_${i}`,
        email: `${TAG}-${i}@example.com`,
        name: `Loadtest ${i}`,
        planName: 'Pro',
        mrrCents: 2900,
        tenureDays: 90,
        cancelledAt,
        status: 'pending',
        source: TAG,
        stripeEnum: hasSignal ? enums[enumIdx] : null,
        stripeComment: hasSignal ? comments[enumIdx] : null,
      })
    }
    await db.insert(churnedSubscribers).values(rows)
    process.stdout.write(`\r  inserted ${Math.min(batchStart + BATCH, TOTAL_ROWS)}/${TOTAL_ROWS}`)
  }
  console.log(`\n  Done in ${Date.now() - t0}ms`)
}

async function queueDepth() {
  const [r] = await db
    .select({ n: count() })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.source, TAG),
      isNull(churnedSubscribers.classifiedAt),
    ))
  return Number(r?.n ?? 0)
}

async function runLoop() {
  console.log('\nRunning classifier ticks until queue drains…')
  const startTime = Date.now()
  let tickNum = 0
  let totalClassified = 0
  let totalFailed = 0
  let totalDeadLettered = 0
  const tickDurations: number[] = []

  while (true) {
    const initialDepth = await queueDepth()
    if (initialDepth === 0) break

    tickNum++
    const tickStart = Date.now()
    const stats = await runClassifierTick()
    const dur = Date.now() - tickStart
    tickDurations.push(dur)
    totalClassified += stats.classified
    totalFailed += stats.failed
    totalDeadLettered += stats.deadLettered

    console.log(`  tick ${tickNum.toString().padStart(2)}: picked=${stats.picked} classified=${stats.classified} failed=${stats.failed} dead=${stats.deadLettered} (${dur}ms) — queue depth: ${initialDepth - stats.classified}`)

    if (stats.picked === 0) break  // safety: no more rows
  }

  const totalDur = Date.now() - startTime
  console.log(`\n  ─── DRAIN COMPLETE ───`)
  console.log(`  Total ticks:        ${tickNum}`)
  console.log(`  Total classified:   ${totalClassified}`)
  console.log(`  Total failed:       ${totalFailed}`)
  console.log(`  Total dead-lettered:${totalDeadLettered}`)
  console.log(`  Total wall time:    ${(totalDur / 1000).toFixed(1)}s`)
  console.log(`  Avg per tick:       ${tickDurations.length > 0 ? (tickDurations.reduce((s, d) => s + d, 0) / tickDurations.length).toFixed(0) : 0}ms`)
  console.log(`  Max tick:           ${tickDurations.length > 0 ? Math.max(...tickDurations) : 0}ms`)
  console.log(`  Min tick:           ${tickDurations.length > 0 ? Math.min(...tickDurations) : 0}ms`)
  console.log(`  Throughput:         ${(totalClassified / (totalDur / 1000)).toFixed(1)} rows/sec`)

  return { tickNum, totalClassified, totalFailed, totalDeadLettered, totalDur }
}

async function verify() {
  console.log('\nVerifying drain completeness + distribution…')
  const [totalRow] = await db
    .select({ n: count() })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.source, TAG))
  const [classifiedRow] = await db
    .select({ n: count() })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.source, TAG),
      sql`${churnedSubscribers.classifiedAt} IS NOT NULL`,
    ))
  const total = Number(totalRow?.n ?? 0)
  const classified = Number(classifiedRow?.n ?? 0)

  console.log(`  ${classified}/${total} rows have classified_at set`)

  const tierDist = await db
    .select({
      tier: churnedSubscribers.tier,
      n: count(),
    })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.source, TAG))
    .groupBy(churnedSubscribers.tier)

  console.log(`  Tier distribution:`)
  for (const r of tierDist) {
    console.log(`    tier ${r.tier ?? 'null'}: ${r.n}`)
  }

  if (classified !== total) {
    console.log(`  ✗ FAIL: ${total - classified} rows not classified`)
    return false
  }
  console.log('  ✓ All rows classified')
  return true
}

async function main() {
  if (CLEANUP_ONLY) {
    await cleanup()
    return
  }

  console.log(`Spec 72 load test — ${TOTAL_ROWS} rows, ${SIGNAL_ROWS} LLM calls expected (~$${(SIGNAL_ROWS * 0.003).toFixed(2)})`)
  console.log(`Press Ctrl+C in the next 5s to cancel.\n`)
  await new Promise((r) => setTimeout(r, 5000))

  await cleanup()
  const customer = await getDevCustomer()
  await seed(customer.id)
  await runLoop()
  const ok = await verify()
  console.log('\nCleaning up…')
  await cleanup()

  if (!ok) process.exit(1)
}

main().catch((e) => { console.error('LOAD TEST FAILED:', e); process.exit(1) })

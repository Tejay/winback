// Spec 65 Phase 3 — test data seeder for the V2 re-engagement cron.
//
// Seeds 9 scenario subscribers + 2 improvements against the dev customer,
// each tagged with a known marker so they can be cleaned up later.
// Temporarily flips the dev customer onto a far-future pilot so the
// billing-pause gate doesn't dominate the test results.
//
// USAGE
//   npx tsx --env-file=.env.local scripts/seed-spec65-v2-test.ts seed
//   npx tsx --env-file=.env.local scripts/seed-spec65-v2-test.ts inspect
//   npx tsx --env-file=.env.local scripts/seed-spec65-v2-test.ts cleanup
//
// After `seed`, trigger the cron:
//   curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reengagement
//
// Then `inspect` to see what actually happened to each scenario subscriber.

import { db } from '../lib/db'
import {
  customers,
  churnedSubscribers,
  improvements,
  improvementMatches,
  emailsSent,
  users,
} from '../lib/schema'
import { and, eq, like, sql } from 'drizzle-orm'

const TAG_EMAIL_PREFIX = 'spec65-test-'
const TAG_IMPROVEMENT  = '[spec65-test]'
const DEV_USER_EMAIL   = 'tejaasvi@gmail.com'

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
}

async function getDevCustomer() {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEV_USER_EMAIL))
    .limit(1)
  if (!user) throw new Error(`User ${DEV_USER_EMAIL} not found`)

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, user.id))
    .limit(1)
  if (!customer) throw new Error('Dev customer not found')
  return customer
}

interface Scenario {
  label:       string
  expected:    string
  email:       string
  name:        string
  cancelledAt: Date
  triggerNeed: string | null
  triggerNeedConfidence: 'high' | 'low' | null
  doNotContact?:  boolean
  lastReengagedAt?: Date | null
  preMatchImprovementTitle?: string  // pre-record a match before cron runs
}

const SCENARIOS: Scenario[] = [
  {
    label: 'S1', expected: 'EMAILED via Bulk CSV improvement',
    email: `${TAG_EMAIL_PREFIX}s1@example.com`, name: 'Sarah Chen',
    cancelledAt: daysAgo(30),
    triggerNeed: 'Wants bulk CSV import for our 50K customer base',
    triggerNeedConfidence: 'high',
  },
  {
    label: 'S2', expected: 'EMAILED via Slack improvement',
    email: `${TAG_EMAIL_PREFIX}s2@example.com`, name: 'Jordan Lee',
    cancelledAt: daysAgo(45),
    triggerNeed: 'Wants Slack notifications when new orders come in',
    triggerNeedConfidence: 'high',
  },
  {
    label: 'S3', expected: 'SKIPPED — low confidence (silent churn)',
    email: `${TAG_EMAIL_PREFIX}s3@example.com`, name: 'Casey Park',
    cancelledAt: daysAgo(60),
    triggerNeed: 'personal reasons',
    triggerNeedConfidence: 'low',
  },
  {
    label: 'S4', expected: 'SKIPPED — no matching improvement (stays eligible)',
    email: `${TAG_EMAIL_PREFIX}s4@example.com`, name: 'Morgan Smith',
    cancelledAt: daysAgo(30),
    triggerNeed: 'Wants native Microsoft Teams integration',
    triggerNeedConfidence: 'high',
  },
  {
    label: 'S5', expected: 'NOT CONSIDERED — within 14-day cooling window',
    email: `${TAG_EMAIL_PREFIX}s5@example.com`, name: 'Taylor Drew',
    cancelledAt: daysAgo(7),
    triggerNeed: 'Wants bulk CSV import',
    triggerNeedConfidence: 'high',
  },
  {
    label: 'S6', expected: 'NOT CONSIDERED — in 60-day cooldown',
    email: `${TAG_EMAIL_PREFIX}s6@example.com`, name: 'Alex Jamie',
    cancelledAt: daysAgo(120),
    triggerNeed: 'Wants bulk CSV import',
    triggerNeedConfidence: 'high',
    lastReengagedAt: daysAgo(30),
  },
  {
    label: 'S7', expected: 'EXPIRED — past 9-month wall, marked lost',
    email: `${TAG_EMAIL_PREFIX}s7@example.com`, name: 'Riley Avery',
    cancelledAt: daysAgo(280),
    triggerNeed: 'Wants bulk CSV import',
    triggerNeedConfidence: 'high',
  },
  {
    label: 'S8', expected: 'SKIPPED — already matched to this improvement',
    email: `${TAG_EMAIL_PREFIX}s8@example.com`, name: 'Quinn Hayden',
    cancelledAt: daysAgo(30),
    triggerNeed: 'Wants bulk CSV import',
    triggerNeedConfidence: 'high',
    preMatchImprovementTitle: `${TAG_IMPROVEMENT} Bulk CSV import`,
  },
  {
    label: 'S9', expected: 'NOT CONSIDERED — DNC',
    email: `${TAG_EMAIL_PREFIX}s9@example.com`, name: 'Cameron Reese',
    cancelledAt: daysAgo(30),
    triggerNeed: 'Wants bulk CSV import',
    triggerNeedConfidence: 'high',
    doNotContact: true,
  },
]

async function seed() {
  const customer = await getDevCustomer()

  // Stash original pilotUntil for restore on cleanup. We write a marker in
  // a free-form spot — using a known wb_events row keyed by name.
  console.log('Current pilotUntil:', customer.pilotUntil)
  const farFuture = new Date('2030-01-01T00:00:00Z')
  await db
    .update(customers)
    .set({ pilotUntil: farFuture, updatedAt: new Date() })
    .where(eq(customers.id, customer.id))
  console.log(`✓ Pilot bypass set: pilotUntil = ${farFuture.toISOString()}`)

  // Improvements
  const csvImp = await db
    .insert(improvements)
    .values({
      customerId:       customer.id,
      title:            `${TAG_IMPROVEMENT} Bulk CSV import`,
      description:      'Removed the 1,000-row cap. Streams to a downloadable export for any size.',
      dateShipped:      daysAgo(3).toISOString().slice(0, 10),
      status:           'published',
      addressesPattern: 'bulk CSV import',
    })
    .returning()

  const slackImp = await db
    .insert(improvements)
    .values({
      customerId:       customer.id,
      title:            `${TAG_IMPROVEMENT} Slack integration`,
      description:      'Channel-routed notifications for new orders.',
      dateShipped:      daysAgo(5).toISOString().slice(0, 10),
      status:           'published',
      addressesPattern: 'Slack notifications',
    })
    .returning()

  console.log(`✓ Created 2 improvements (CSV=${csvImp[0].id.slice(0, 8)}, Slack=${slackImp[0].id.slice(0, 8)})`)

  // Subscribers
  const inserted: Array<{ label: string; id: string; email: string; expected: string }> = []
  for (const s of SCENARIOS) {
    const [row] = await db
      .insert(churnedSubscribers)
      .values({
        customerId:            customer.id,
        stripeCustomerId:      `cus_${TAG_EMAIL_PREFIX}${s.label.toLowerCase()}`,
        stripeSubscriptionId:  `sub_${TAG_EMAIL_PREFIX}${s.label.toLowerCase()}`,
        stripePriceId:         null,
        email:                 s.email,
        name:                  s.name,
        planName:              'Pro',
        mrrCents:              4900,
        tenureDays:            90,
        everUpgraded:          false,
        nearRenewal:           false,
        paymentFailures:       0,
        previousSubs:          0,
        stripeEnum:            null,
        stripeComment:         s.triggerNeed,
        cancelledAt:           s.cancelledAt,
        status:                'contacted',
        doNotContact:          s.doNotContact ?? false,
        triggerNeed:           s.triggerNeed,
        triggerNeedConfidence: s.triggerNeedConfidence,
        cancellationCategory:  'Feature',
        cancellationReason:    'see triggerNeed',
        lastReengagedAt:       s.lastReengagedAt ?? null,
      })
      .returning()
    inserted.push({ label: s.label, id: row.id, email: s.email, expected: s.expected })

    if (s.preMatchImprovementTitle) {
      const impId = s.preMatchImprovementTitle === `${TAG_IMPROVEMENT} Bulk CSV import` ? csvImp[0].id : slackImp[0].id
      await db.insert(improvementMatches).values({
        improvementId: impId,
        subscriberId:  row.id,
        emailedAt:     daysAgo(31),
      })
    }
  }

  console.log('\n✓ Seeded subscribers:')
  for (const r of inserted) {
    console.log(`  ${r.label.padEnd(3)} ${r.email.padEnd(40)} → ${r.expected}`)
  }

  console.log('\nNext: trigger the cron and then `inspect`:')
  console.log('  curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/reengagement')
  console.log('  npx tsx --env-file=.env.local scripts/seed-spec65-v2-test.ts inspect')
}

async function inspect() {
  const customer = await getDevCustomer()
  const subs = await db
    .select()
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customer.id),
      like(churnedSubscribers.email, `${TAG_EMAIL_PREFIX}%`),
    ))

  console.log(`\n${subs.length} test subscribers:\n`)
  console.log('label  status      expired?  emailed?  cooldown  notes')
  console.log('-------------------------------------------------------------------------------')
  const sorted = [...subs].sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''))
  for (const s of sorted) {
    const label = (s.email ?? '').replace(TAG_EMAIL_PREFIX, '').replace('@example.com', '').toUpperCase()
    const expired = s.reengagementExpiredAt ? 'YES' : '-'
    const emailedRow = await db
      .select({ id: emailsSent.id })
      .from(emailsSent)
      .where(and(eq(emailsSent.subscriberId, s.id), eq(emailsSent.type, 'reengagement')))
      .limit(1)
    const emailed = emailedRow.length > 0 ? 'YES' : '-'
    const cooldown = s.lastReengagedAt
      ? `${Math.floor((Date.now() - s.lastReengagedAt.getTime()) / (24 * 60 * 60 * 1000))}d ago`
      : '-'
    let notes = ''
    if (s.triggerNeedConfidence === 'low') notes = 'low-confidence (silent churn)'
    if (s.doNotContact) notes = 'DNC'
    if (s.status === 'lost') notes = 'lost'

    console.log(
      `${label.padEnd(6)} ${(s.status ?? '?').padEnd(11)} ${expired.padEnd(9)} ${emailed.padEnd(9)} ${cooldown.padEnd(9)} ${notes}`,
    )
  }

  // Show improvement_matches rows for these subs
  const matchRows = await db.execute(sql.raw(`
    SELECT im.improvement_id, im.subscriber_id, im.matched_at IS NOT NULL AS matched, im.emailed_at IS NOT NULL AS emailed
    FROM wb_improvement_matches im
    JOIN wb_churned_subscribers s ON s.id = im.subscriber_id
    WHERE s.email LIKE '${TAG_EMAIL_PREFIX}%'
  `))
  console.log(`\n${matchRows.rows?.length ?? 0} improvement_matches rows for test subscribers.`)
}

async function cleanup() {
  const customer = await getDevCustomer()

  // Delete subscribers (cascades through improvement_matches + emails_sent)
  const dropped = await db
    .delete(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customer.id),
      like(churnedSubscribers.email, `${TAG_EMAIL_PREFIX}%`),
    ))
    .returning({ id: churnedSubscribers.id })
  console.log(`✓ Deleted ${dropped.length} test subscribers (+ cascade)`)

  // Delete tagged improvements
  const droppedImps = await db
    .delete(improvements)
    .where(and(
      eq(improvements.customerId, customer.id),
      like(improvements.title, `${TAG_IMPROVEMENT}%`),
    ))
    .returning({ id: improvements.id })
  console.log(`✓ Deleted ${droppedImps.length} test improvements`)

  // Restore pilotUntil. We assume it was null before (typical for the
  // dev merchant). If you need to restore a specific date, do it manually.
  await db
    .update(customers)
    .set({ pilotUntil: null, updatedAt: new Date() })
    .where(eq(customers.id, customer.id))
  console.log(`✓ pilotUntil reset to null on dev customer`)
}

async function main() {
  const cmd = process.argv[2]
  if (cmd === 'seed')    return seed()
  if (cmd === 'inspect') return inspect()
  if (cmd === 'cleanup') return cleanup()
  console.error('Usage: ... seed | inspect | cleanup')
  process.exit(1)
}

main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1) })

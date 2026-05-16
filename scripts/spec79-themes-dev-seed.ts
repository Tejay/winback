// Spec 79 — dev seed for cancellation themes.
//
// Inserts 3 primary themes + 1 post-ship insight into wb_cancellation_themes
// for the local-dev merchant so the /reasons UI renders the new card with
// realistic content. Idempotent: deletes prior themes for the customer
// first, then inserts fresh.
//
// The post-ship insight requires at least one shipped improvement to
// reference. The seed picks the most recent kind='product' published row;
// if there isn't one, it creates a synthetic "Bulk CSV import" reason so
// the insight has somewhere to point.
//
// Run:
//   npx tsx --env-file=.env.local scripts/spec79-themes-dev-seed.ts
//
// Reset:
//   npx tsx --env-file=.env.local scripts/spec79-themes-dev-seed.ts --reset
//
// Note: this inserts STATIC themes for UI development. In production the
// rows are written by /api/cron/cluster-cancellations which runs the LLM
// clusterer over real cancellation data weekly.

import { db } from '../lib/db'
import { users, customers, cancellationThemes, improvements } from '../lib/schema'
import { and, desc, eq } from 'drizzle-orm'

const TEJ_EMAIL = process.env.TEJ_EMAIL ?? 'tejaasvi@gmail.com'

async function findCustomerId(): Promise<string> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, TEJ_EMAIL)).limit(1)
  if (!u) throw new Error(`No wb_users row for ${TEJ_EMAIL}`)
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) throw new Error(`No wb_customers row for user ${TEJ_EMAIL}`)
  return c.id
}

async function ensureShippedImprovement(customerId: string): Promise<{ id: string; title: string }> {
  const [latest] = await db
    .select({ id: improvements.id, title: improvements.title })
    .from(improvements)
    .where(and(
      eq(improvements.customerId, customerId),
      eq(improvements.kind, 'product'),
      eq(improvements.status, 'published'),
    ))
    .orderBy(desc(improvements.dateShipped))
    .limit(1)
  if (latest) {
    console.log(`[seed] reusing existing improvement ${latest.id} ("${latest.title}") for the post-ship insight`)
    return latest
  }
  // Synthesize one ~25 days ago so "shipped X days ago" reads sensibly.
  const shippedAt = new Date(Date.now() - 25 * 24 * 60 * 60 * 1000)
  const [inserted] = await db
    .insert(improvements)
    .values({
      customerId,
      kind:             'product',
      title:            'Bulk CSV import — up to 100K rows',
      description:      'Lifted the 10K row cap; uploads up to 100K rows in a single shot.',
      dateShipped:      shippedAt.toISOString().slice(0, 10),
      addressesPattern: 'csv|bulk import|upload',
      preempted:        false,
      status:           'published',
    })
    .returning({ id: improvements.id, title: improvements.title })
  console.log(`[seed] created synthetic improvement ${inserted.id} ("${inserted.title}") for the post-ship insight`)
  return inserted
}

async function main() {
  const customerId = await findCustomerId()
  console.log(`[seed] customer: ${customerId} (${TEJ_EMAIL})`)

  // Always wipe first — both --reset and the normal seed path start clean.
  await db.delete(cancellationThemes).where(eq(cancellationThemes.customerId, customerId))
  console.log('[seed] wiped prior themes for this customer')

  if (process.argv.includes('--reset')) {
    console.log('[reset] done')
    return
  }

  const shipped = await ensureShippedImprovement(customerId)

  // Stable test-mode UUIDs so the seeded subscriberIds are RFC-valid.
  // Real cron output uses live churnedSubscribers.id values.
  const FAKE = (n: number) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`

  const windowStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const windowEnd   = new Date()

  // Primary themes (addressesImprovementId = null)
  await db.insert(cancellationThemes).values([
    {
      customerId,
      addressesImprovementId: null,
      title:                  'Native Slack integration',
      description:            'Wanted a first-party Slack app with channel routing, not just the Zapier workaround.',
      category:               'Feature',
      emoji:                  '🔥',
      customerCount:          5,
      subscriberIds:          [FAKE(1), FAKE(2), FAKE(3), FAKE(4), FAKE(5)],
      sampleQuotes:           [
        "If you ship native Slack integration I'll absolutely come back. The Zapier route is too brittle for our team.",
        "We need real Slack support with channel routing — moving to Linear which has it built-in.",
        "Cancelling for now, ping me when there's a proper Slack app — would re-sub same day.",
      ],
      windowStart,
      windowEnd,
    },
    {
      customerId,
      addressesImprovementId: null,
      title:                  'SAML / SSO for enterprise',
      description:            'Compliance teams blocked renewals because there is no SAML or SCIM. All on annual plans.',
      category:               'Feature',
      emoji:                  '📊',
      customerCount:          4,
      subscriberIds:          [FAKE(6), FAKE(7), FAKE(8), FAKE(9)],
      sampleQuotes:           [
        "Our IT team said no SAML, no renewal. Hard requirement.",
        "Need SSO for SOC2 — happy to talk when it lands.",
      ],
      windowStart,
      windowEnd,
    },
    {
      customerId,
      addressesImprovementId: null,
      title:                  'Mobile app — was promised, never shipped',
      description:            'Customers on the road want to check status from a phone.',
      category:               'Feature',
      emoji:                  '🌱',
      customerCount:          3,
      subscriberIds:          [FAKE(0), FAKE(1), FAKE(2)],
      sampleQuotes:           [
        "The mobile app was on the roadmap when I signed up. It's been a year.",
        "Need to check in from my phone during meetings. Web only is a dealbreaker.",
      ],
      windowStart,
      windowEnd,
    },
    // Post-ship insight: references the shipped improvement
    {
      customerId,
      addressesImprovementId: shipped.id,
      title:                  'Bulk CSV — still falling short after ship',
      description:            'shipped version raised row caps but missed escaping, field mapping, and updates',
      category:               'Feature',
      emoji:                  '💡',
      customerCount:          3,
      subscriberIds:          [FAKE(3), FAKE(4), FAKE(5)],
      sampleQuotes:           [
        "Bulk import still chokes on multi-line cells. Needed proper CSV escaping, not just bigger row limits.",
        "100K rows is nice but no way to map fields without re-uploading. Switching to a tool that has a real import wizard.",
        "Tried the new bulk import last week — still no way to update existing rows, only insert. Cancelling.",
      ],
      windowStart,
      windowEnd,
    },
  ])

  console.log('[seed] inserted 3 primary themes + 1 post-ship insight')
  console.log('\n[seed] visit http://localhost:3000/reasons to see the card.')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

// Spec 79 — clusterer realism test for a medium-volume merchant.
//
// What this does:
//   1. Seeds ~36 synthetic churned subscribers against tejaasvi@gmail.com's
//      customer row, with realistic triggerNeed strings that ought to
//      cluster into 6-7 themes (plus 6 singletons that should be filtered).
//   2. Seeds one shipped improvement ("Improved performance for large
//      files") dated 30 days ago, with several recent cancellations still
//      citing the same area — should produce a post-ship insight.
//   3. Calls clusterCancellationsForCustomer() directly (no cron) — this
//      makes a REAL Anthropic API call.
//   4. Prints the resulting wb_cancellation_themes table so you can
//      eyeball quality.
//
// Run:
//   npx tsx --env-file=.env.local scripts/spec79-cluster-test.ts
//
// Reset (drops the synthetic subs + shipped improvement + themes):
//   npx tsx --env-file=.env.local scripts/spec79-cluster-test.ts --reset
//
// Cost: one Anthropic call per run, modest token count (~5-10k input,
// 1-2k output). Cents.

import { db } from '../lib/db'
import {
  users, customers, churnedSubscribers, improvements, cancellationThemes,
} from '../lib/schema'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { clusterCancellationsForCustomer } from '../src/winback/lib/cluster-cancellations'

const TEJ_EMAIL = process.env.TEJ_EMAIL ?? 'tejaasvi@gmail.com'
const SEED_TAG  = 'spec79-cluster-test'

// ─── Synthetic data: 7 themes + 1 shipped-but-still-cited + 6 noise ──
//
// The triggerNeed strings deliberately use varied wording for the same
// underlying need — testing whether the LLM groups semantic siblings.
interface SyntheticSub {
  email:        string
  triggerNeed:  string
  category:     'Price' | 'Feature' | 'Other'
  mrrCents:     number
  daysAgo:      number          // when did they cancel
  /** Set when this cancellation matches a theme we want to verify clusters. */
  expectedTheme?: string
}

const SUBSCRIBERS: SyntheticSub[] = [
  // Theme A — Figma integration (6)
  { email: 'a1@test.com', triggerNeed: "Wanted a real Figma plugin — manually exporting kills our workflow.",        category: 'Feature', mrrCents: 4900, daysAgo:  8, expectedTheme: 'figma' },
  { email: 'a2@test.com', triggerNeed: "Need direct Figma integration. The CSV bridge is too many steps.",            category: 'Feature', mrrCents: 4900, daysAgo: 14, expectedTheme: 'figma' },
  { email: 'a3@test.com', triggerNeed: "Figma sync is a dealbreaker — designers won't switch tools without it.",      category: 'Feature', mrrCents: 9900, daysAgo: 22, expectedTheme: 'figma' },
  { email: 'a4@test.com', triggerNeed: "No Figma support, so we're moving to a competitor that has it built in.",     category: 'Feature', mrrCents: 4900, daysAgo: 30, expectedTheme: 'figma' },
  { email: 'a5@test.com', triggerNeed: "Import from Figma is missing. We had to copy/paste everything.",              category: 'Feature', mrrCents: 4900, daysAgo: 45, expectedTheme: 'figma' },
  { email: 'a6@test.com', triggerNeed: "A Figma plugin would close the gap for us — please consider it.",             category: 'Feature', mrrCents: 4900, daysAgo: 60, expectedTheme: 'figma' },

  // Theme B — Team workspaces (5)
  { email: 'b1@test.com', triggerNeed: "No way to share projects with my team — each of us has a separate account.",  category: 'Feature', mrrCents: 4900, daysAgo: 11, expectedTheme: 'teams'  },
  { email: 'b2@test.com', triggerNeed: "Need a real team workspace. Sharing via links is hacky.",                     category: 'Feature', mrrCents: 9900, daysAgo: 18, expectedTheme: 'teams'  },
  { email: 'b3@test.com', triggerNeed: "Can't collaborate with my team properly. No shared workspace concept.",       category: 'Feature', mrrCents: 4900, daysAgo: 26, expectedTheme: 'teams'  },
  { email: 'b4@test.com', triggerNeed: "Team plan didn't actually give us shared workspaces — just shared billing.",  category: 'Feature', mrrCents: 9900, daysAgo: 33, expectedTheme: 'teams'  },
  { email: 'b5@test.com', triggerNeed: "Workspaces per team would have kept us. Single-user-only doesn't scale.",     category: 'Feature', mrrCents: 4900, daysAgo: 50, expectedTheme: 'teams'  },

  // Theme C — Pricing too high for solo (4, Price category)
  { email: 'c1@test.com', triggerNeed: "Too expensive for a solo founder. The pro tier is overkill for one person.",  category: 'Price',   mrrCents: 4900, daysAgo:  9, expectedTheme: 'price' },
  { email: 'c2@test.com', triggerNeed: "Pricing is brutal for individual use — need a $9 solo tier.",                  category: 'Price',   mrrCents: 4900, daysAgo: 19, expectedTheme: 'price' },
  { email: 'c3@test.com', triggerNeed: "Price doesn't work for one person. Lowering wouldn't have changed my mind.",  category: 'Price',   mrrCents: 4900, daysAgo: 35, expectedTheme: 'price' },
  { email: 'c4@test.com', triggerNeed: "Need a cheaper solo plan. I don't need any of the team features.",            category: 'Price',   mrrCents: 4900, daysAgo: 52, expectedTheme: 'price' },

  // Theme D — Performance on large files (4) — 3 dated AFTER the
  // shipped "Improved performance" improvement (which sits at 30 days
  // ago). These three should drive the POST-SHIP INSIGHT.
  { email: 'd1@test.com', triggerNeed: "App is laggy with big files. Even after the recent update it still chokes.",  category: 'Other',   mrrCents: 4900, daysAgo:  6, expectedTheme: 'perf-post-ship' },
  { email: 'd2@test.com', triggerNeed: "Performance is unusable past 500 elements. Tried again last week, no change.", category: 'Other',  mrrCents: 4900, daysAgo: 12, expectedTheme: 'perf-post-ship' },
  { email: 'd3@test.com', triggerNeed: "Slow with complex docs — the recent perf work helped a little but not enough.", category: 'Other', mrrCents: 9900, daysAgo: 18, expectedTheme: 'perf-post-ship' },
  { email: 'd4@test.com', triggerNeed: "Performance drops noticeably on large projects.",                              category: 'Other',   mrrCents: 4900, daysAgo: 55, expectedTheme: 'perf-pre-ship'  },

  // Theme E — Better video tutorials (5)
  { email: 'e1@test.com', triggerNeed: "Documentation is text-only. Need video tutorials to actually learn this.",    category: 'Other',   mrrCents: 4900, daysAgo:  7, expectedTheme: 'tutorials' },
  { email: 'e2@test.com', triggerNeed: "No video help, very hard to onboard new team members.",                       category: 'Other',   mrrCents: 9900, daysAgo: 16, expectedTheme: 'tutorials' },
  { email: 'e3@test.com', triggerNeed: "Video onboarding is missing. Reading 30 docs pages doesn't cut it.",          category: 'Other',   mrrCents: 4900, daysAgo: 24, expectedTheme: 'tutorials' },
  { email: 'e4@test.com', triggerNeed: "Would love walkthrough videos for the advanced features.",                    category: 'Other',   mrrCents: 4900, daysAgo: 40, expectedTheme: 'tutorials' },
  { email: 'e5@test.com', triggerNeed: "No video content. I learn by watching, not reading.",                         category: 'Other',   mrrCents: 4900, daysAgo: 65, expectedTheme: 'tutorials' },

  // Theme F — No offline mode (3)
  { email: 'f1@test.com', triggerNeed: "Needs to work offline. I travel a lot and lose internet constantly.",         category: 'Feature', mrrCents: 4900, daysAgo: 13, expectedTheme: 'offline' },
  { email: 'f2@test.com', triggerNeed: "No offline support is a problem for client site visits.",                     category: 'Feature', mrrCents: 4900, daysAgo: 28, expectedTheme: 'offline' },
  { email: 'f3@test.com', triggerNeed: "Can't use without internet — dealbreaker for field work.",                    category: 'Feature', mrrCents: 4900, daysAgo: 42, expectedTheme: 'offline' },

  // Theme G — API access (3)
  { email: 'g1@test.com', triggerNeed: "No API for automation. Would have integrated with our CRM if you had one.",   category: 'Feature', mrrCents: 9900, daysAgo: 10, expectedTheme: 'api' },
  { email: 'g2@test.com', triggerNeed: "Needs a developer API. Manual export every week is silly.",                   category: 'Feature', mrrCents: 4900, daysAgo: 21, expectedTheme: 'api' },
  { email: 'g3@test.com', triggerNeed: "Would integrate via API if one existed — moving to a tool that has it.",      category: 'Feature', mrrCents: 4900, daysAgo: 38, expectedTheme: 'api' },

  // Noise — 6 single complaints (should be filtered out at the
  // MIN_THEME_SIZE=3 step, never reach the output)
  { email: 'n1@test.com', triggerNeed: "Didn't fit our workflow.",                                                    category: 'Other',   mrrCents: 4900, daysAgo: 17 },
  { email: 'n2@test.com', triggerNeed: "Found something better at a similar price.",                                  category: 'Other',   mrrCents: 4900, daysAgo: 29 },
  { email: 'n3@test.com', triggerNeed: "Our company shut down — nothing to do with the product.",                     category: 'Other',   mrrCents: 4900, daysAgo: 36 },
  { email: 'n4@test.com', triggerNeed: "Moving to an in-house tool.",                                                 category: 'Other',   mrrCents: 4900, daysAgo: 44 },
  { email: 'n5@test.com', triggerNeed: "Team restructure, no longer need this tool.",                                 category: 'Other',   mrrCents: 4900, daysAgo: 58 },
  { email: 'n6@test.com', triggerNeed: "Lost project ownership when I left my previous role.",                        category: 'Other',   mrrCents: 4900, daysAgo: 70 },
]

const SHIPPED_IMPROVEMENT = {
  title:        'Improved performance for large files',
  description:  'Rewrote the renderer; large projects now load 4× faster and stay responsive past 1,000 elements.',
  daysAgo:      30,
}

// ─── Helpers ────────────────────────────────────────────────────────
async function findCustomerId(): Promise<string> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, TEJ_EMAIL)).limit(1)
  if (!u) throw new Error(`No wb_users row for ${TEJ_EMAIL}`)
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) throw new Error(`No wb_customers row for user ${TEJ_EMAIL}`)
  return c.id
}

async function reset(customerId: string): Promise<void> {
  // Subscribers tagged with our SEED_TAG
  const subs = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customerId),
      eq(churnedSubscribers.source, SEED_TAG),
    ))
  if (subs.length > 0) {
    await db.delete(churnedSubscribers).where(inArray(churnedSubscribers.id, subs.map((s) => s.id)))
    console.log(`[reset] deleted ${subs.length} synthetic subscribers`)
  }
  // Improvement
  const imps = await db
    .select({ id: improvements.id })
    .from(improvements)
    .where(and(
      eq(improvements.customerId, customerId),
      eq(improvements.title, SHIPPED_IMPROVEMENT.title),
    ))
  if (imps.length > 0) {
    await db.delete(improvements).where(inArray(improvements.id, imps.map((i) => i.id)))
    console.log(`[reset] deleted ${imps.length} synthetic improvement(s)`)
  }
  // Themes for this customer (cron writes these; we wipe them too so the
  // run starts clean)
  await db.delete(cancellationThemes).where(eq(cancellationThemes.customerId, customerId))
  console.log('[reset] wiped themes for this customer')
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const customerId = await findCustomerId()
  console.log(`[seed] customer: ${customerId} (${TEJ_EMAIL})`)

  if (process.argv.includes('--reset')) {
    await reset(customerId)
    console.log('[reset] done')
    return
  }

  // Always start clean so re-runs produce fresh comparable results
  await reset(customerId)

  // 1. Insert shipped improvement
  const shippedAt = new Date(Date.now() - SHIPPED_IMPROVEMENT.daysAgo * 24 * 60 * 60 * 1000)
  await db.insert(improvements).values({
    customerId,
    kind:             'product',
    title:            SHIPPED_IMPROVEMENT.title,
    description:      SHIPPED_IMPROVEMENT.description,
    dateShipped:      shippedAt.toISOString().slice(0, 10),
    addressesPattern: null,
    preempted:        false,
    status:           'published',
  })
  console.log(`[seed] inserted improvement "${SHIPPED_IMPROVEMENT.title}" shipped ${SHIPPED_IMPROVEMENT.daysAgo} days ago`)

  // 2. Insert subscribers
  for (const s of SUBSCRIBERS) {
    const cancelledAt = new Date(Date.now() - s.daysAgo * 24 * 60 * 60 * 1000)
    await db.insert(churnedSubscribers).values({
      customerId,
      stripeCustomerId:      `cus_test_${s.email.replace(/[@.]/g, '_')}`,
      email:                 s.email,
      name:                  s.email.split('@')[0],
      planName:              'Test',
      mrrCents:              s.mrrCents,
      cancellationReason:    s.triggerNeed.slice(0, 100),
      cancellationCategory:  s.category,
      tier:                  1,
      confidence:            '0.92',
      triggerNeed:           s.triggerNeed,
      triggerNeedConfidence: 'high',
      classifiedAt:          new Date(),
      status:                'pending',
      cancelledAt,
      source:                SEED_TAG,
    })
  }
  console.log(`[seed] inserted ${SUBSCRIBERS.length} synthetic subscribers across 7 expected themes + 6 noise singletons`)

  // 3. Run the clusterer (real LLM call)
  console.log(`\n[cluster] calling clusterCancellationsForCustomer() — real Anthropic call, ~30s`)
  const t0 = Date.now()
  const result = await clusterCancellationsForCustomer(customerId)
  const elapsedSec = Math.round((Date.now() - t0) / 1000)
  console.log(`[cluster] done in ${elapsedSec}s\n`)
  console.log('[cluster] result:', JSON.stringify(result, null, 2))

  // 4. Read back + print the themes table
  const themes = await db
    .select({
      id:                     cancellationThemes.id,
      addressesImprovementId: cancellationThemes.addressesImprovementId,
      title:                  cancellationThemes.title,
      description:            cancellationThemes.description,
      category:               cancellationThemes.category,
      customerCount:          cancellationThemes.customerCount,
      sampleQuotes:           cancellationThemes.sampleQuotes,
      subscriberIds:          cancellationThemes.subscriberIds,
    })
    .from(cancellationThemes)
    .where(eq(cancellationThemes.customerId, customerId))
    .orderBy(desc(cancellationThemes.customerCount))

  console.log(`\n${'═'.repeat(76)}`)
  console.log(`  ${themes.length} theme(s) clustered. Expected ≈ 7 primary + 1 post-ship insight.`)
  console.log(`${'═'.repeat(76)}\n`)

  for (const t of themes) {
    const kind = t.addressesImprovementId ? '💡 POST-SHIP INSIGHT' : '   PRIMARY THEME    '
    console.log(`[${kind}]  ${t.customerCount} customers · ${t.category ?? '?'}`)
    console.log(`  title:        ${t.title}`)
    console.log(`  description:  ${t.description}`)
    console.log(`  quotes:`)
    for (const q of t.sampleQuotes) {
      console.log(`    - "${q.length > 100 ? q.slice(0, 97) + '…' : q}"`)
    }
    if (t.addressesImprovementId) {
      console.log(`  ↪ addresses improvement: ${t.addressesImprovementId}`)
    }
    console.log()
  }

  // Quick coverage check: which expected themes did we hit?
  const expectedThemes = new Set(SUBSCRIBERS.filter((s) => s.expectedTheme).map((s) => s.expectedTheme!))
  console.log(`Expected theme labels (by my hand-grouping): ${[...expectedThemes].join(', ')}`)
  console.log(`Actual cluster count: ${themes.length}`)
  console.log(`Subscribers clustered: ${themes.reduce((s, t) => s + t.subscriberIds.length, 0)} / ${SUBSCRIBERS.length} (6 noise singletons should be filtered)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })

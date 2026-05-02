/**
 * Demo seed for marketing-screenshot dashboards.
 *
 * Creates a clean, isolated demo account populated with realistic-looking
 * data so every feature on the dashboard renders well for screenshots:
 *   - Both KPI rows (win-back + payment recovery) with non-zero numbers
 *   - Win-back: handoff alert, has-reply chip, top-reasons strip, recovered + lost mix
 *   - Payment recovery: $X/mo at risk + on-final-attempt count, decline-code strip,
 *     dunning rows in T1 / T2 / final-retry / recovered / lost
 *
 * Idempotent: deletes the existing demo user (cascading wipe of customer +
 * subscribers + recoveries + emails) before re-seeding. Re-run as often as
 * you like.
 *
 * Run with:   npx tsx scripts/seed-demo.ts
 *
 * Login credentials printed at the end.
 */
import { config } from 'dotenv'
// Next.js loads .env.local automatically; tsx scripts need an explicit hint.
// Fall back to .env so the script also works in CI / production contexts.
config({ path: '.env.local' })
config()
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db } from '../lib/db'
import {
  users,
  customers,
  churnedSubscribers,
  recoveries,
  emailsSent,
} from '../lib/schema'
import { encrypt } from '../src/winback/lib/encryption'

const DEMO_EMAIL = 'demo@winbackflow.co'
const DEMO_PASSWORD = 'demo1234'
const DEMO_NAME = 'Demo Founder'
const DEMO_PRODUCT = 'Aurora Analytics'

// Helpers -------------------------------------------------------------

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}
function daysAgo(d: number): Date {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000)
}
function startOfThisMonth(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}
function thisMonthDaysAgo(d: number): Date {
  // Returns "d days ago" but clamps to start-of-month + 1h so it always
  // counts as this-month for the dashboard's monthly aggregations.
  const candidate = daysAgo(d)
  const monthStart = startOfThisMonth()
  if (candidate < monthStart) {
    return new Date(monthStart.getTime() + 60 * 60 * 1000)
  }
  return candidate
}

// Realistic-looking data -----------------------------------------------

const FIRST_NAMES = ['Alex', 'Sarah', 'Jordan', 'Priya', 'Marcus', 'Mia', 'Diego', 'Olivia', 'Noah', 'Ava', 'Liam', 'Emma', 'Lucas', 'Sophia', 'Riley', 'Quinn', 'Taylor', 'Avery', 'Reese', 'Jamie', 'Casey', 'Ethan', 'Maya', 'Theo']
const LAST_NAMES = ['Chen', 'Patel', 'Thompson', 'Reyes', 'Okafor', 'Schmidt', 'Nguyen', 'Hartwell', 'Rivera', 'Kim', 'Andersson', 'Cohen', 'Morales', 'Whitfield', 'Singh', 'Abasolo', 'Larsson', 'Brennan']
const DOMAINS = ['aurora-design.io', 'frostbyte.dev', 'quietbox.app', 'lumencraft.io', 'pulsegrid.co', 'ridge-co.com', 'beacon.studio', 'glasshaus.app', 'stickleback.tech', 'midmornin.com', 'thirdcoffee.co', 'yarrow.so']

const PLANS: Array<{ name: string; mrrCents: number }> = [
  { name: 'Starter',  mrrCents: 1900 },
  { name: 'Growth',   mrrCents: 2900 },
  { name: 'Pro',      mrrCents: 4900 },
  { name: 'Team',     mrrCents: 8900 },
  { name: 'Scale',    mrrCents: 14900 },
]

type WinBackReason = {
  category: string
  reason: string
  tier: number
  stripeEnum: string
  stripeComment: string
  triggerNeed: string | null
  triggerKeyword: string | null
}
const WINBACK_REASONS: WinBackReason[] = [
  { category: 'Price', reason: 'Too expensive for our team right now', tier: 2,
    stripeEnum: 'too_expensive',
    stripeComment: "honestly the price doubled in 6 months and we can't justify it anymore",
    triggerNeed: 'A lower-tier plan around the $19/mo mark for small teams',
    triggerKeyword: 'starter plan' },
  { category: 'Price', reason: 'Just shopping around — found a cheaper alternative', tier: 3,
    stripeEnum: 'too_expensive',
    stripeComment: 'too expensive vs alternatives',
    triggerNeed: null, triggerKeyword: null },
  { category: 'Price', reason: "Budget freeze this quarter — we'll be back", tier: 1,
    stripeEnum: 'too_expensive',
    stripeComment: 'budget freeze this quarter — please ping me in 90 days',
    triggerNeed: 'Q2-budget-cycle re-engagement', triggerKeyword: 'budget' },
  { category: 'Feature', reason: 'Missing the Slack integration we need', tier: 1,
    stripeEnum: 'missing_features',
    stripeComment: 'we need slack integration with custom channel routing',
    triggerNeed: 'Slack integration with per-team channel routing',
    triggerKeyword: 'slack' },
  { category: 'Feature', reason: 'No way to bulk-edit campaigns; doing it one-by-one is killing us', tier: 2,
    stripeEnum: 'missing_features',
    stripeComment: 'bulk edit. seriously.',
    triggerNeed: 'Bulk edit / multi-select on the campaigns list',
    triggerKeyword: 'bulk edit' },
  { category: 'Feature', reason: 'We need multi-team / multi-workspace support', tier: 1,
    stripeEnum: 'missing_features',
    stripeComment: 'we have 3 teams that need separate workspaces',
    triggerNeed: 'Multi-workspace support with per-workspace billing',
    triggerKeyword: 'workspace' },
  { category: 'Quality', reason: 'Email deliverability went downhill the last 2 weeks', tier: 1,
    stripeEnum: 'low_quality',
    stripeComment: "deliverability has been bad. opens dropped 40% — wasn't us, our other tools are fine",
    triggerNeed: 'Stable inbox-placement rates / a status page',
    triggerKeyword: 'deliverability' },
  { category: 'Quality', reason: 'Too many bugs we kept tripping over', tier: 2,
    stripeEnum: 'low_quality',
    stripeComment: 'three different bugs in two weeks. lost trust.',
    triggerNeed: null, triggerKeyword: null },
  { category: 'Switched', reason: 'Moving to Customer.io — needed their journeys feature', tier: 3,
    stripeEnum: 'switched_service',
    stripeComment: 'moved to customer.io for journeys',
    triggerNeed: 'Multi-step automated journeys with branching logic',
    triggerKeyword: 'journeys' },
  { category: 'Switched', reason: 'Switched to a custom internal tool', tier: 3,
    stripeEnum: 'switched_service',
    stripeComment: 'built our own internal tool, no longer need this',
    triggerNeed: null, triggerKeyword: null },
  { category: 'Unused', reason: "We never really got around to using it", tier: 3,
    stripeEnum: 'unused',
    stripeComment: 'never got it set up properly',
    triggerNeed: null, triggerKeyword: null },
  { category: 'Unused', reason: 'Honestly forgot about it — sorry', tier: 3,
    stripeEnum: 'unused',
    stripeComment: '',
    triggerNeed: null, triggerKeyword: null },
]

const DECLINE_CODES = ['insufficient_funds', 'expired_card', 'do_not_honor', 'generic_decline']

function randomCustomer(): { name: string; email: string } {
  const first = pick(FIRST_NAMES)
  const last = pick(LAST_NAMES)
  return {
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@${pick(DOMAINS)}`,
  }
}

// Seeding --------------------------------------------------------------

async function wipeExistingDemo(): Promise<void> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEMO_EMAIL))
    .limit(1)
  if (existing.length === 0) return
  const userId = existing[0].id

  // wb_recoveries.customer_id is a non-cascading FK, so delete recoveries
  // explicitly before nuking the customer. emails_sent and
  // churned_subscribers cascade via their parent customer's FK chain.
  const customerRows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, userId))
  for (const { id: customerId } of customerRows) {
    await db.delete(recoveries).where(eq(recoveries.customerId, customerId))
  }

  await db.delete(users).where(eq(users.email, DEMO_EMAIL))
  console.log(`Wiped existing demo user (${userId})`)
}

async function seedDemo(): Promise<void> {
  console.log('Seeding demo data…')

  await wipeExistingDemo()

  // 1. User + customer
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10)
  const [user] = await db.insert(users).values({
    email: DEMO_EMAIL,
    passwordHash,
    name: DEMO_NAME,
    emailVerifiedAt: new Date(),  // skip email verification gate
    isAdmin: true,                // unlock /admin screens for the demo
  }).returning({ id: users.id })

  const fakeStripeToken = encrypt('demo_fake_stripe_access_token_not_real')
  const [customer] = await db.insert(customers).values({
    userId: user.id,
    stripeAccessToken: fakeStripeToken,
    stripeAccountId: 'acct_demo_seed',
    founderName: DEMO_NAME,
    productName: DEMO_PRODUCT,
    onboardingComplete: true,
    plan: 'trial',
    activatedAt: daysAgo(60),
    backfillStartedAt: daysAgo(60),
    backfillCompletedAt: daysAgo(60),
  }).returning({ id: customers.id })

  console.log(`Created user ${user.id} + customer ${customer.id}`)

  // 2. Win-back churned subscribers --------------------------------------

  type WinBackSeed = {
    daysSinceCancel: number
    status: 'recovered' | 'contacted' | 'pending' | 'lost' | 'skipped'
    handoff?: boolean
    hasReply?: boolean
    aiPaused?: boolean
  }

  const winBackSeeds: WinBackSeed[] = [
    // Recovered (8) — distributed across this month + history
    { daysSinceCancel: 2,  status: 'recovered' },
    { daysSinceCancel: 5,  status: 'recovered' },
    { daysSinceCancel: 11, status: 'recovered' },
    { daysSinceCancel: 18, status: 'recovered' },
    { daysSinceCancel: 24, status: 'recovered' },
    { daysSinceCancel: 35, status: 'recovered' },
    { daysSinceCancel: 48, status: 'recovered' },
    { daysSinceCancel: 60, status: 'recovered' },

    // Contacted, in active outreach (6) — these surface in "In progress"
    { daysSinceCancel: 1, status: 'contacted' },
    { daysSinceCancel: 1, status: 'contacted', hasReply: true },
    { daysSinceCancel: 2, status: 'contacted' },
    { daysSinceCancel: 3, status: 'contacted', hasReply: true },
    { daysSinceCancel: 4, status: 'contacted' },
    { daysSinceCancel: 6, status: 'contacted', aiPaused: true },

    // Handoffs needing attention (3) — "Needs you" alert
    { daysSinceCancel: 1, status: 'contacted', handoff: true },
    { daysSinceCancel: 2, status: 'contacted', handoff: true, hasReply: true },
    { daysSinceCancel: 4, status: 'contacted', handoff: true },

    // Lost (4) — for the recovery-rate denominator
    { daysSinceCancel: 28, status: 'lost' },
    { daysSinceCancel: 41, status: 'lost' },
    { daysSinceCancel: 55, status: 'lost' },
    { daysSinceCancel: 80, status: 'lost' },

    // Skipped — AI suppressed (1) — shown in "Done"
    { daysSinceCancel: 9, status: 'skipped' },
  ]

  for (const seed of winBackSeeds) {
    const cust = randomCustomer()
    const plan = pick(PLANS)
    const reason = pick(WINBACK_REASONS)
    const cancelledAt = daysAgo(seed.daysSinceCancel)

    const [sub] = await db.insert(churnedSubscribers).values({
      customerId: customer.id,
      stripeCustomerId: `cus_demo_${Math.random().toString(36).slice(2, 10)}`,
      stripeSubscriptionId: `sub_demo_${Math.random().toString(36).slice(2, 10)}`,
      email: cust.email,
      name: cust.name,
      planName: plan.name,
      mrrCents: plan.mrrCents,
      tenureDays: 30 + Math.floor(Math.random() * 540),
      cancellationReason: reason.reason,
      cancellationCategory: reason.category,
      tier: reason.tier,
      confidence: '0.78',
      stripeEnum: reason.stripeEnum,
      stripeComment: reason.stripeComment || null,
      triggerNeed: reason.triggerNeed,
      triggerKeyword: reason.triggerKeyword,
      status: seed.status,
      cancelledAt,
      source: 'webhook',
      handoffReasoning: seed.handoff
        ? "Founder might know this person — they've replied to support before"
        : 'Standard exit-email path; AI confidence high',
      recoveryLikelihood: seed.status === 'recovered' ? 'high' : pick(['high', 'medium', 'low']),
      founderHandoffAt: seed.handoff ? daysAgo(seed.daysSinceCancel - 0.5) : null,
      founderHandoffResolvedAt: null,
      aiPausedUntil: seed.aiPaused ? daysAgo(-5) : null,
      aiPausedAt: seed.aiPaused ? daysAgo(seed.daysSinceCancel - 0.5) : null,
      aiPausedReason: seed.aiPaused ? 'manual pause from drawer' : null,
    }).returning({ id: churnedSubscribers.id })

    // Emails sent (always for contacted/recovered/handoff/lost; not for skipped)
    if (seed.status !== 'skipped' && seed.status !== 'pending') {
      await db.insert(emailsSent).values({
        subscriberId: sub.id,
        type: 'exit',
        subject: `Quick note before you go, ${cust.name.split(' ')[0]}`,
        bodyText: `Hi ${cust.name.split(' ')[0]},\n\nI saw you cancelled today. No hard sell — I just wanted to check whether ${reason.category === 'Feature' ? 'the feature you were missing was on our roadmap' : reason.category === 'Price' ? 'pricing was the friction here' : 'we screwed something up'}.\n\nReply to this email if you want to chat.\n\n— ${DEMO_NAME}`,
        sentAt: new Date(cancelledAt.getTime() + 60 * 1000),
        repliedAt: seed.hasReply ? new Date(cancelledAt.getTime() + 4 * 60 * 60 * 1000) : null,
      })
    }

    // Recovered subs get a recoveries row + a recovered timestamp this-month-ish
    if (seed.status === 'recovered') {
      const recoveredAt = thisMonthDaysAgo(Math.max(1, seed.daysSinceCancel - 1))
      await db.insert(recoveries).values({
        subscriberId: sub.id,
        customerId: customer.id,
        recoveredAt,
        planMrrCents: plan.mrrCents,
        recoveryType: 'win_back',
        attributionType: pick(['strong', 'strong', 'weak']),  // most strong
        newStripeSubId: `sub_demo_new_${Math.random().toString(36).slice(2, 10)}`,
      })
    }
  }
  console.log(`Inserted ${winBackSeeds.length} win-back rows`)

  // 3. Payment-recovery churned subscribers ------------------------------

  type PaymentSeed = {
    daysSinceFailed: number
    state: 'awaiting_retry' | 'final_retry_pending' | 'churned_during_dunning' | 'recovered_during_dunning'
    touchCount: 1 | 2 | 3
    declineCode: string
    recovered?: boolean   // produces a recoveries row + status='recovered'
  }

  const paymentSeeds: PaymentSeed[] = [
    // In retry (T1) — 4 rows
    { daysSinceFailed: 0,  state: 'awaiting_retry', touchCount: 1, declineCode: 'insufficient_funds' },
    { daysSinceFailed: 1,  state: 'awaiting_retry', touchCount: 1, declineCode: 'do_not_honor' },
    { daysSinceFailed: 2,  state: 'awaiting_retry', touchCount: 2, declineCode: 'expired_card' },
    { daysSinceFailed: 3,  state: 'awaiting_retry', touchCount: 2, declineCode: 'insufficient_funds' },

    // On final retry (T3) — 3 rows
    { daysSinceFailed: 4, state: 'final_retry_pending', touchCount: 3, declineCode: 'insufficient_funds' },
    { daysSinceFailed: 5, state: 'final_retry_pending', touchCount: 3, declineCode: 'expired_card' },
    { daysSinceFailed: 6, state: 'final_retry_pending', touchCount: 3, declineCode: 'generic_decline' },

    // Recovered during dunning — 5 rows (the "win column" for payment recovery)
    { daysSinceFailed: 1,  state: 'recovered_during_dunning', touchCount: 1, declineCode: 'insufficient_funds', recovered: true },
    { daysSinceFailed: 3,  state: 'recovered_during_dunning', touchCount: 2, declineCode: 'expired_card',       recovered: true },
    { daysSinceFailed: 5,  state: 'recovered_during_dunning', touchCount: 1, declineCode: 'do_not_honor',       recovered: true },
    { daysSinceFailed: 9,  state: 'recovered_during_dunning', touchCount: 2, declineCode: 'insufficient_funds', recovered: true },
    { daysSinceFailed: 18, state: 'recovered_during_dunning', touchCount: 3, declineCode: 'expired_card',       recovered: true },

    // Lost (Stripe gave up, customer didn't fix the card) — 2 rows
    { daysSinceFailed: 14, state: 'churned_during_dunning', touchCount: 3, declineCode: 'insufficient_funds' },
    { daysSinceFailed: 22, state: 'churned_during_dunning', touchCount: 3, declineCode: 'do_not_honor' },
  ]

  for (const seed of paymentSeeds) {
    const cust = randomCustomer()
    const plan = pick(PLANS)
    const failedAt = daysAgo(seed.daysSinceFailed)
    const nextRetry = seed.state === 'awaiting_retry' || seed.state === 'final_retry_pending'
      ? daysAgo(-1 - Math.random() * 1.5)  // ~1-2 days in the future
      : null

    const [sub] = await db.insert(churnedSubscribers).values({
      customerId: customer.id,
      stripeCustomerId: `cus_demo_pf_${Math.random().toString(36).slice(2, 10)}`,
      stripeSubscriptionId: `sub_demo_pf_${Math.random().toString(36).slice(2, 10)}`,
      email: cust.email,
      name: cust.name,
      planName: plan.name,
      mrrCents: plan.mrrCents,
      cancellationReason: 'Payment failed',
      cancellationCategory: 'Other',
      tier: 2,
      confidence: '0.90',
      status: seed.recovered ? 'recovered' : seed.state === 'churned_during_dunning' ? 'lost' : 'pending',
      source: 'webhook',
      // cancelledAt intentionally NULL — payment-recovery rows don't carry a
      // cancelled timestamp (this is what /api/stats was previously misreading;
      // see Spec 40 fix).
      paymentMethodAtFailure: `pm_demo_${Math.random().toString(36).slice(2, 10)}`,
      nextPaymentAttemptAt: nextRetry,
      dunningTouchCount: seed.touchCount,
      dunningLastTouchAt: new Date(failedAt.getTime() + 30 * 60 * 1000),
      dunningState: seed.state,
      lastDeclineCode: seed.declineCode,
      createdAt: failedAt,  // make it count for "this month" decline-code aggregation
    }).returning({ id: churnedSubscribers.id })

    // One 'dunning' email row per subscriber — production uses a unique
    // index (subscriber_id, type) and tracks touch progression via the
    // dunningTouchCount column on the subscriber, not via repeated rows.
    await db.insert(emailsSent).values({
      subscriberId: sub.id,
      type: 'dunning',
      subject: "Your payment didn't go through",
      bodyText: `Hi ${cust.name.split(' ')[0]},\n\nWe couldn't process your latest payment for ${plan.name} (${seed.declineCode}). Update your card here to keep things running:\n\n[Update payment]\n\n— ${DEMO_NAME}`,
      sentAt: new Date(failedAt.getTime() + 60 * 1000),
    })

    if (seed.recovered) {
      const recoveredAt = thisMonthDaysAgo(Math.max(0.5, seed.daysSinceFailed - 1))
      await db.insert(recoveries).values({
        subscriberId: sub.id,
        customerId: customer.id,
        recoveredAt,
        planMrrCents: plan.mrrCents,
        recoveryType: 'card_save',
        attributionType: 'strong',
      })
    }
  }
  console.log(`Inserted ${paymentSeeds.length} payment-recovery rows`)

  console.log('\n✓ Demo seed complete\n')
  console.log('   Login:', DEMO_EMAIL)
  console.log('   Pwd:  ', DEMO_PASSWORD)
  console.log('   →     /login → /dashboard\n')
}

seedDemo()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })

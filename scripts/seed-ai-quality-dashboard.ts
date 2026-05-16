/**
 * Spec 78 — Seed varied data so /admin/ai-quality renders meaningfully
 * on the dev founder account.
 *
 *   npx tsx --env-file=.env.local scripts/seed-ai-quality-dashboard.ts
 *   npx tsx --env-file=.env.local scripts/seed-ai-quality-dashboard.ts --cleanup
 *
 * What it seeds:
 *   - ~140 churned subscribers spread across calibration cohort
 *     (30-90d ago), drift windows (0-7d / 8-30d), and recent activity
 *     so every block has populated data.
 *   - Internal consistency:
 *       Block 1 calibration is MONOTONIC by construction —
 *         high likelihood recovers more than medium more than low.
 *       Block 2 drift has Tier-4 share spiking in the last 7d so the
 *         ⚠ flag is visible.
 *       Block 3 category mix covers all 6 categories.
 *       Block 4 auto-lost includes high-score cases (Feature category,
 *         high MRR, billing-portal click, multiple replies) AND
 *         low-score (dead-text patterns).
 *       Block 5 handoffs include all four resolution states
 *         (open-fresh / open-stale / resolved-recovered / resolved-lost).
 *       Block 6 ~12 low-confidence classifications.
 *       Block 7 match rate has emailed / pending / expired buckets.
 *   - subscriber_auto_lost events with properties.subscriberId properly
 *     set so Block 4 + Block 1's auto-lost calculations work.
 *
 * All rows tagged `source = 'ai-quality-seed'` for precise cleanup.
 */

import { db } from '../lib/db'
import {
  users, customers, churnedSubscribers, wbEvents, emailsSent, subscriberReplies,
} from '../lib/schema'
import { and, eq, inArray } from 'drizzle-orm'

const TAG = 'ai-quality-seed'
const CLEANUP = process.argv.includes('--cleanup')
const NOW = Date.now()
const D = 24 * 60 * 60 * 1000

const CATEGORIES = ['Price', 'Competitor', 'Feature', 'Unused', 'Quality', 'Other'] as const
type Category = (typeof CATEGORIES)[number]

const REASON_BY_CATEGORY: Record<Category, string[]> = {
  Price:      ['Too expensive for my current stage', 'Pricing went up unexpectedly', 'Need a cheaper plan'],
  Competitor: ['Switching to Substack', 'Moving to ConvertKit', 'Trying Beehiiv'],
  Feature:    ['Wanted Slack notifications', 'Need a Zapier integration', 'Missing CSV bulk import'],
  Unused:     ['Wasn\'t using it enough', 'Took a break from the project', 'Forgot I had this subscription'],
  Quality:    ['Too many bugs in the editor', 'Sync was unreliable', 'Performance issues on mobile'],
  Other:      ['Personal reasons', 'Going in a different direction', 'Trying something new'],
}

// Dead-text patterns — Block 4's smart ranking penalises these.
const DEAD_TEXT_REASONS = [
  'Company shut down',
  'Going out of business',
  'No longer in business',
]

function dateNdaysAgo(n: number): Date {
  return new Date(NOW - n * D)
}

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length]
}

async function getDevCustomerId(): Promise<string> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  if (!u) throw new Error('Dev user tejaasvi@gmail.com not found — log in once first')
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) throw new Error('Dev customer not found for tejaasvi@gmail.com')
  return c.id
}

async function cleanup(customerId: string) {
  // Find subscribers tagged with our seed source, capture their ids, then
  // delete the dependent rows BEFORE deleting the subscribers themselves
  // (some FKs cascade, some don't — be explicit).
  const seededSubs = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customerId),
      eq(churnedSubscribers.source, TAG),
    ))
  const ids = seededSubs.map((s) => s.id)
  if (ids.length === 0) {
    console.log('  No prior seed rows found.')
    return
  }

  // wb_events rows where properties.subscriberId in our seeded ids.
  // Using inArray with the jsonb arrow path requires a raw SQL idiom;
  // simplest is to delete all subscriber_auto_lost / founder_handoff_triggered
  // events for this customer within the seed timeframe.
  // The seeded subs are all scoped to this customer so it's safe.
  const eventDeleted = await db
    .delete(wbEvents)
    .where(and(
      eq(wbEvents.customerId, customerId),
      inArray(wbEvents.name, ['subscriber_auto_lost', 'founder_handoff_triggered']),
    ))
    .returning({ id: wbEvents.id })

  // emails_sent and subscriber_replies cascade on subscriber delete,
  // but we delete them explicitly first to be safe and so the counts
  // are visible in cleanup output.
  const emailsDeleted = await db
    .delete(emailsSent)
    .where(inArray(emailsSent.subscriberId, ids))
    .returning({ id: emailsSent.id })
  const repliesDeleted = await db
    .delete(subscriberReplies)
    .where(inArray(subscriberReplies.subscriberId, ids))
    .returning({ id: subscriberReplies.id })

  const subsDeleted = await db
    .delete(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customerId),
      eq(churnedSubscribers.source, TAG),
    ))
    .returning({ id: churnedSubscribers.id })

  console.log(`  Cleaned ${subsDeleted.length} subscribers, ${eventDeleted.length} events, ${emailsDeleted.length} emails, ${repliesDeleted.length} replies`)
}

type SeedSub = {
  customerId: string
  daysAgo: number               // classifiedAt + cancelledAt offset
  /** null = Tier-4-style suppress (no email on file). */
  email: string | null
  name: string
  mrrCents: number
  tenureDays: number
  category: Category | null
  reason: string | null
  tier: 1 | 2 | 3 | 4
  confidence: string            // '0.XX' decimal(3,2)
  recoveryLikelihood: 'high' | 'medium' | 'low'
  status: 'pending' | 'contacted' | 'recovered' | 'lost'
  // Optional behavioural signals
  billingPortalClicked?: boolean
  triggerNeedConfidence?: 'high' | 'low' | null
  reengagementExpiredDaysAgo?: number       // sets reengagement_expired_at
  founderHandoffDaysAgo?: number | null     // sets founder_handoff_at; null = no handoff
  founderHandoffResolvedDaysAgo?: number | null
  fireAutoLostEvent?: boolean               // adds subscriber_auto_lost event
  fireHandoffEvent?: boolean                // adds founder_handoff_triggered event
  numReplies?: number                       // populates wb_subscriber_replies
  numReengagementEmails?: number            // populates wb_emails_sent type='reengagement'
  // Internal tag for cleanup logging
  bucketTag: string
}

function buildSub(
  customerId: string,
  i: number,
  bucketTag: string,
  overrides: Partial<SeedSub> & { daysAgo: number; recoveryLikelihood: SeedSub['recoveryLikelihood']; status: SeedSub['status'] },
): SeedSub {
  const category = overrides.category !== undefined ? overrides.category : pick(CATEGORIES, i)
  const reason = overrides.reason !== undefined
    ? overrides.reason
    : (category ? pick(REASON_BY_CATEGORY[category], i) : null)
  const isTier4 = overrides.tier === 4
  // Explicit null check so the `??` fallback doesn't replace an
  // intentionally-null email with a generated one (Tier-4 subs).
  const email = isTier4
    ? null
    : (overrides.email === null
        ? null
        : (overrides.email ?? `${bucketTag}-${i}-${NOW}@seed.test`))
  return {
    customerId,
    daysAgo:    overrides.daysAgo,
    email,
    name:       overrides.name  ?? `Seed-${bucketTag} #${i + 1}`,
    mrrCents:   overrides.mrrCents ?? [1900, 2900, 4900, 9900][i % 4],
    tenureDays: overrides.tenureDays ?? 30 + (i * 13) % 365,
    category,
    reason,
    tier:       overrides.tier ?? (category === null ? 3 : 1),
    confidence: overrides.confidence ?? '0.75',
    recoveryLikelihood: overrides.recoveryLikelihood,
    status:     overrides.status,
    billingPortalClicked: overrides.billingPortalClicked ?? false,
    triggerNeedConfidence: overrides.triggerNeedConfidence ?? null,
    reengagementExpiredDaysAgo: overrides.reengagementExpiredDaysAgo,
    founderHandoffDaysAgo: overrides.founderHandoffDaysAgo ?? null,
    founderHandoffResolvedDaysAgo: overrides.founderHandoffResolvedDaysAgo ?? null,
    fireAutoLostEvent: overrides.fireAutoLostEvent ?? false,
    fireHandoffEvent: overrides.fireHandoffEvent ?? false,
    numReplies: overrides.numReplies ?? 0,
    numReengagementEmails: overrides.numReengagementEmails ?? 0,
    bucketTag,
  }
}

function buildPlan(customerId: string): SeedSub[] {
  const subs: SeedSub[] = []
  let i = 0

  // ---------- Calibration cohort: 30-90 days ago ----------
  // Goal: monotonic recovery — high > medium > low
  //   high (n=15):    7 recovered, 1 auto-lost, 1 lost-other, 6 still-open
  //   medium (n=25):  5 recovered, 6 auto-lost, 5 lost-other, 9 still-open
  //   low (n=30):     2 recovered, 14 auto-lost, 10 lost-other, 4 still-open

  // High-likelihood: lots of recoveries
  for (let k = 0; k < 7; k++) {
    subs.push(buildSub(customerId, i++, 'calib-high-recovered', {
      daysAgo: 35 + k * 7,
      recoveryLikelihood: 'high',
      status: 'recovered',
      tier: 1,
      confidence: '0.85',
    }))
  }
  for (let k = 0; k < 1; k++) {
    subs.push(buildSub(customerId, i++, 'calib-high-autolost', {
      daysAgo: 50,
      recoveryLikelihood: 'high',
      status: 'lost',
      tier: 1,
      confidence: '0.80',
      fireAutoLostEvent: true,
      numReplies: 2,
    }))
  }
  for (let k = 0; k < 1; k++) {
    subs.push(buildSub(customerId, i++, 'calib-high-lost', {
      daysAgo: 80,
      recoveryLikelihood: 'high',
      status: 'lost',
      tier: 1,
      confidence: '0.82',
    }))
  }
  for (let k = 0; k < 6; k++) {
    subs.push(buildSub(customerId, i++, 'calib-high-open', {
      daysAgo: 30 + k * 10,
      recoveryLikelihood: 'high',
      status: 'contacted',
      tier: 1,
      confidence: '0.78',
    }))
  }

  // Medium-likelihood
  for (let k = 0; k < 5; k++) {
    subs.push(buildSub(customerId, i++, 'calib-med-recovered', {
      daysAgo: 40 + k * 8,
      recoveryLikelihood: 'medium',
      status: 'recovered',
      tier: 2,
      confidence: '0.60',
    }))
  }
  for (let k = 0; k < 6; k++) {
    subs.push(buildSub(customerId, i++, 'calib-med-autolost', {
      daysAgo: 45 + k * 6,
      recoveryLikelihood: 'medium',
      status: 'lost',
      tier: 2,
      confidence: '0.55',
      fireAutoLostEvent: true,
      numReplies: 1,
    }))
  }
  for (let k = 0; k < 5; k++) {
    subs.push(buildSub(customerId, i++, 'calib-med-lost', {
      daysAgo: 75 + k * 3,
      recoveryLikelihood: 'medium',
      status: 'lost',
      tier: 2,
      confidence: '0.50',
    }))
  }
  for (let k = 0; k < 9; k++) {
    subs.push(buildSub(customerId, i++, 'calib-med-open', {
      daysAgo: 35 + k * 5,
      recoveryLikelihood: 'medium',
      status: 'contacted',
      tier: 2,
      confidence: '0.58',
    }))
  }

  // Low-likelihood
  for (let k = 0; k < 2; k++) {
    subs.push(buildSub(customerId, i++, 'calib-low-recovered', {
      daysAgo: 60 + k * 10,
      recoveryLikelihood: 'low',
      status: 'recovered',
      tier: 3,
      confidence: '0.30',
    }))
  }
  for (let k = 0; k < 14; k++) {
    subs.push(buildSub(customerId, i++, 'calib-low-autolost', {
      daysAgo: 32 + k * 4,
      recoveryLikelihood: 'low',
      status: 'lost',
      tier: 3,
      confidence: '0.28',
      fireAutoLostEvent: true,
      numReplies: k % 3 === 0 ? 2 : 1,
    }))
  }
  for (let k = 0; k < 10; k++) {
    subs.push(buildSub(customerId, i++, 'calib-low-lost', {
      daysAgo: 70 + k * 2,
      recoveryLikelihood: 'low',
      status: 'lost',
      tier: 3,
      confidence: '0.32',
    }))
  }
  for (let k = 0; k < 4; k++) {
    subs.push(buildSub(customerId, i++, 'calib-low-open', {
      daysAgo: 38 + k * 12,
      recoveryLikelihood: 'low',
      status: 'pending',
      tier: 3,
      confidence: '0.35',
    }))
  }

  // ---------- Block 1: Auto-lost reversal (2 cases) ----------
  // Cases that fired subscriber_auto_lost AND ended up status='recovered'
  for (let k = 0; k < 2; k++) {
    subs.push(buildSub(customerId, i++, 'calib-reversed', {
      daysAgo: 55 + k * 10,
      recoveryLikelihood: 'medium',
      status: 'recovered',
      tier: 2,
      confidence: '0.55',
      fireAutoLostEvent: true,
      numReplies: 2,
      mrrCents: 4900,
    }))
  }

  // ---------- Block 1: Handoff cohort (12 in cohort: 4 recovered, 8 not) ----------
  for (let k = 0; k < 4; k++) {
    subs.push(buildSub(customerId, i++, 'calib-handoff-recovered', {
      daysAgo: 35 + k * 8,
      recoveryLikelihood: 'high',
      status: 'recovered',
      tier: 1,
      confidence: '0.88',
      founderHandoffDaysAgo: 30 + k * 8,
      founderHandoffResolvedDaysAgo: 20 + k * 8,
      fireHandoffEvent: true,
      mrrCents: 9900,
    }))
  }
  for (let k = 0; k < 8; k++) {
    subs.push(buildSub(customerId, i++, 'calib-handoff-lost', {
      daysAgo: 45 + k * 5,
      recoveryLikelihood: 'medium',
      status: 'lost',
      tier: 2,
      confidence: '0.62',
      founderHandoffDaysAgo: 40 + k * 5,
      founderHandoffResolvedDaysAgo: 30 + k * 5,
      fireHandoffEvent: true,
    }))
  }

  // ---------- Block 2: Drift — last 7d vs prior 23d ----------
  // Last 7d: a Tier-4 spike (3 of 12 = 25%) so the ⚠ flag lights up.
  // Confidence dropping slightly across the week.
  for (let k = 0; k < 12; k++) {
    const isT4 = k < 3  // 3 Tier-4 in last 7d (~25% — spike vs baseline ~7%)
    subs.push(buildSub(customerId, i++, 'drift-recent7d', {
      daysAgo: 1 + (k % 7),
      recoveryLikelihood: k % 3 === 0 ? 'high' : k % 3 === 1 ? 'medium' : 'low',
      status: 'contacted',
      tier: isT4 ? 4 : ((k % 3) + 1) as 1 | 2 | 3,
      category: isT4 ? null : pick(CATEGORIES, k),
      reason: isT4 ? null : pick(REASON_BY_CATEGORY[pick(CATEGORIES, k)], k),
      confidence: '0.58',
      email: isT4 ? null : undefined,  // null = no email on file (Tier-4 trigger)
    }))
  }
  // Prior 23d (days 8-30 ago): baseline — fewer Tier-4 (2 of 30 = ~7%), higher confidence.
  for (let k = 0; k < 30; k++) {
    const isT4 = k < 2
    subs.push(buildSub(customerId, i++, 'drift-prior23d', {
      daysAgo: 8 + (k % 23),
      recoveryLikelihood: k % 4 === 0 ? 'high' : k % 4 < 3 ? 'medium' : 'low',
      status: 'contacted',
      tier: isT4 ? 4 : ((k % 3) + 1) as 1 | 2 | 3,
      category: isT4 ? null : pick(CATEGORIES, k + 1),
      reason: isT4 ? null : pick(REASON_BY_CATEGORY[pick(CATEGORIES, k + 1)], k),
      confidence: '0.71',
      email: isT4 ? null : undefined as unknown as string,
    }))
  }

  // ---------- Block 4: High-stakes auto-lost (recent) ----------
  // Mix of high-score (Feature, high MRR, replies, portal click) and low-score (dead text).
  // High-score 1: Feature, $99/mo, portal-clicked, 2 replies, 200d tenure
  subs.push(buildSub(customerId, i++, 'autolost-highscore-1', {
    daysAgo: 4,
    recoveryLikelihood: 'medium',
    status: 'lost',
    tier: 1,
    confidence: '0.55',
    category: 'Feature',
    reason: 'Need a Zapier integration; without it our team can\'t use this',
    mrrCents: 9900,
    tenureDays: 200,
    billingPortalClicked: true,
    fireAutoLostEvent: true,
    numReplies: 2,
  }))
  // High-score 2: Quality, $49/mo, 3 replies, 120d tenure
  subs.push(buildSub(customerId, i++, 'autolost-highscore-2', {
    daysAgo: 6,
    recoveryLikelihood: 'medium',
    status: 'lost',
    tier: 1,
    confidence: '0.60',
    category: 'Quality',
    reason: 'Sync has been broken for two weeks and support said it\'s a known issue',
    mrrCents: 4900,
    tenureDays: 120,
    fireAutoLostEvent: true,
    numReplies: 3,
  }))
  // Low-score: dead-text pattern, low MRR
  subs.push(buildSub(customerId, i++, 'autolost-lowscore', {
    daysAgo: 5,
    recoveryLikelihood: 'low',
    status: 'lost',
    tier: 1,
    confidence: '0.40',
    category: 'Other',
    reason: DEAD_TEXT_REASONS[0],
    mrrCents: 900,
    tenureDays: 45,
    fireAutoLostEvent: true,
    numReplies: 1,
  }))

  // ---------- Block 5: Handoff resolution states (recent) ----------
  // Open fresh
  for (let k = 0; k < 2; k++) {
    subs.push(buildSub(customerId, i++, 'handoff-open-fresh', {
      daysAgo: 2 + k,
      recoveryLikelihood: 'medium',
      status: 'contacted',
      tier: 1,
      confidence: '0.65',
      mrrCents: 4900,
      category: 'Feature',
      founderHandoffDaysAgo: 2 + k,
      founderHandoffResolvedDaysAgo: null,
      fireHandoffEvent: true,
      numReplies: 1,
    }))
  }
  // Open stale (>=7d)
  subs.push(buildSub(customerId, i++, 'handoff-open-stale', {
    daysAgo: 12,
    recoveryLikelihood: 'medium',
    status: 'contacted',
    tier: 1,
    confidence: '0.60',
    mrrCents: 2900,
    category: 'Competitor',
    founderHandoffDaysAgo: 10,
    founderHandoffResolvedDaysAgo: null,
    fireHandoffEvent: true,
    numReplies: 1,
  }))
  // Resolved → recovered
  for (let k = 0; k < 3; k++) {
    subs.push(buildSub(customerId, i++, 'handoff-resolved-recovered', {
      daysAgo: 14 + k * 3,
      recoveryLikelihood: 'high',
      status: 'recovered',
      tier: 1,
      confidence: '0.85',
      mrrCents: 9900,
      category: 'Feature',
      founderHandoffDaysAgo: 12 + k * 3,
      founderHandoffResolvedDaysAgo: 8 + k * 3,
      fireHandoffEvent: true,
      numReplies: 2,
      billingPortalClicked: true,
    }))
  }
  // Resolved → lost
  for (let k = 0; k < 2; k++) {
    subs.push(buildSub(customerId, i++, 'handoff-resolved-lost', {
      daysAgo: 20 + k * 4,
      recoveryLikelihood: 'medium',
      status: 'lost',
      tier: 2,
      confidence: '0.55',
      mrrCents: 1900,
      category: 'Unused',
      founderHandoffDaysAgo: 18 + k * 4,
      founderHandoffResolvedDaysAgo: 14 + k * 4,
      fireHandoffEvent: true,
    }))
  }

  // ---------- Block 6: Low-confidence (10 in last 21 days) ----------
  for (let k = 0; k < 10; k++) {
    const conf = ['0.32', '0.28', '0.35', '0.25', '0.38'][k % 5]
    subs.push(buildSub(customerId, i++, 'low-conf', {
      daysAgo: 1 + k * 2,
      recoveryLikelihood: 'low',
      status: 'contacted',
      tier: 3,
      confidence: conf,
      category: pick(CATEGORIES, k + 2),
      reason: pick(REASON_BY_CATEGORY[pick(CATEGORIES, k + 2)], k),
      mrrCents: 1900,
    }))
  }

  // ---------- Block 7: Re-engagement match rate ----------
  // 10 eligible + emailed
  for (let k = 0; k < 10; k++) {
    subs.push(buildSub(customerId, i++, 'reeng-emailed', {
      daysAgo: 20 + k * 5,
      recoveryLikelihood: 'medium',
      status: 'contacted',
      tier: 1,
      confidence: '0.70',
      triggerNeedConfidence: 'high',
      numReengagementEmails: 1,
      category: 'Feature',
    }))
  }
  // 8 eligible + pending (in window, no email, no expiry)
  for (let k = 0; k < 8; k++) {
    subs.push(buildSub(customerId, i++, 'reeng-pending', {
      daysAgo: 10 + k * 4,
      recoveryLikelihood: 'medium',
      status: 'contacted',
      tier: 1,
      confidence: '0.65',
      triggerNeedConfidence: 'high',
      category: 'Feature',
    }))
  }
  // 5 eligible + expired
  for (let k = 0; k < 5; k++) {
    subs.push(buildSub(customerId, i++, 'reeng-expired', {
      daysAgo: 60 + k * 4,
      recoveryLikelihood: 'low',
      status: 'lost',
      tier: 1,
      confidence: '0.55',
      triggerNeedConfidence: 'high',
      reengagementExpiredDaysAgo: 5 + k * 2,
      category: 'Feature',
    }))
  }

  return subs
}

async function seedSubscribers(plan: SeedSub[]): Promise<Map<string, string>> {
  // Map of email -> generated subscriber id for downstream FK references.
  // Tier-4 (null email) subscribers don't need downstream events/emails so
  // we skip them from the lookup map — they're inserted but not referenced.
  const idByEmail = new Map<string, string>()

  const rows = plan.map((s, idx) => {
    const classifiedAt = dateNdaysAgo(s.daysAgo)
    return {
      customerId:           s.customerId,
      stripeCustomerId:     `cus_${TAG}_${idx}_${NOW}`,
      stripeSubscriptionId: `sub_${TAG}_${idx}_${NOW}`,
      email:                s.email,
      name:                 s.name,
      planName:             'Seed Plan',
      mrrCents:             s.mrrCents,
      tenureDays:           s.tenureDays,
      stripeComment:        s.reason,
      cancellationReason:   s.reason,
      cancellationCategory: s.category,
      tier:                 s.tier,
      confidence:           s.confidence,
      recoveryLikelihood:   s.recoveryLikelihood,
      handoffReasoning:     s.fireHandoffEvent
        ? 'Seed-handoff: stated concrete blocker, asked specific question'
        : 'Seed-classification: no handoff warranted',
      status:               s.status,
      cancelledAt:          classifiedAt,
      classifiedAt:         classifiedAt,
      source:               TAG,
      billingPortalClickedAt: s.billingPortalClicked ? classifiedAt : null,
      founderHandoffAt:     s.founderHandoffDaysAgo != null
        ? dateNdaysAgo(s.founderHandoffDaysAgo)
        : null,
      founderHandoffResolvedAt: s.founderHandoffResolvedDaysAgo != null
        ? dateNdaysAgo(s.founderHandoffResolvedDaysAgo)
        : null,
      triggerNeedConfidence: s.triggerNeedConfidence,
      triggerNeed:           s.triggerNeedConfidence === 'high'
        ? `Wants ${s.category === 'Feature' ? 'a specific integration' : 'something concrete'}`
        : null,
      reengagementExpiredAt: s.reengagementExpiredDaysAgo != null
        ? dateNdaysAgo(s.reengagementExpiredDaysAgo)
        : null,
    }
  })

  // Insert in batches of 25 and capture ids back.
  for (let i = 0; i < rows.length; i += 25) {
    const batch = rows.slice(i, i + 25)
    const inserted = await db
      .insert(churnedSubscribers)
      .values(batch)
      .returning({ id: churnedSubscribers.id, email: churnedSubscribers.email })
    for (const r of inserted) {
      if (r.email) idByEmail.set(r.email, r.id)
    }
  }
  return idByEmail
}

async function seedEvents(plan: SeedSub[], idByEmail: Map<string, string>, customerId: string) {
  const eventRows: Array<{
    customerId: string
    name: string
    properties: Record<string, unknown>
    createdAt: Date
  }> = []
  for (const s of plan) {
    if (s.email === null) continue
    const subId = idByEmail.get(s.email)
    if (!subId) continue
    if (s.fireAutoLostEvent) {
      eventRows.push({
        customerId,
        name: 'subscriber_auto_lost',
        properties: {
          subscriberId: subId,
          reason: 'budget_exhausted_no_handoff',
          recoveryLikelihood: s.recoveryLikelihood,
          reasoningExcerpt: 'Seed: budget exhausted without handoff decision — closing out',
        },
        // Fire the event shortly AFTER classification so it appears in the
        // recent-events window the dashboard queries.
        createdAt: dateNdaysAgo(Math.max(0, s.daysAgo - 1)),
      })
    }
    if (s.fireHandoffEvent && s.founderHandoffDaysAgo != null) {
      eventRows.push({
        customerId,
        name: 'founder_handoff_triggered',
        properties: { subscriberId: subId, trigger: 'reply_classification' },
        createdAt: dateNdaysAgo(s.founderHandoffDaysAgo),
      })
    }
  }
  if (eventRows.length > 0) {
    for (let i = 0; i < eventRows.length; i += 25) {
      await db.insert(wbEvents).values(eventRows.slice(i, i + 25))
    }
  }
  console.log(`  Seeded ${eventRows.length} events`)
}

async function seedEmailsAndReplies(plan: SeedSub[], idByEmail: Map<string, string>) {
  const emailRows: Array<{
    subscriberId: string
    type: string
    subject: string | null
    bodyText: string | null
    sentAt: Date
  }> = []
  const replyRows: Array<{
    subscriberId: string
    body: string
    fromEmail: string | null
    receivedAt: Date
  }> = []

  for (const s of plan) {
    if (s.email === null) continue
    const subId = idByEmail.get(s.email)
    if (!subId) continue
    // One exit email per subscriber that has a category set (i.e. not Tier 4)
    if (s.category !== null) {
      emailRows.push({
        subscriberId: subId,
        type: 'exit',
        subject: 'Hey — saw you cancelled',
        bodyText: `Seed exit email for ${s.name}. Reason classified as ${s.category}.`,
        sentAt: dateNdaysAgo(Math.max(0, s.daysAgo - 0.1)),
      })
    }
    // Re-engagement emails
    for (let k = 0; k < (s.numReengagementEmails ?? 0); k++) {
      emailRows.push({
        subscriberId: subId,
        type: 'reengagement',
        subject: 'We shipped what you asked for',
        bodyText: 'Seed re-engagement email.',
        sentAt: dateNdaysAgo(Math.max(0, s.daysAgo - 14)),
      })
    }
    // Replies
    for (let k = 0; k < (s.numReplies ?? 0); k++) {
      replyRows.push({
        subscriberId: subId,
        body: `Seed reply #${k + 1} from ${s.name}. Asking about ${s.category ?? 'something'}.`,
        fromEmail: s.email,
        receivedAt: dateNdaysAgo(Math.max(0, s.daysAgo - 0.5 - k * 0.3)),
      })
    }
  }

  for (let i = 0; i < emailRows.length; i += 25) {
    await db.insert(emailsSent).values(emailRows.slice(i, i + 25))
  }
  for (let i = 0; i < replyRows.length; i += 25) {
    await db.insert(subscriberReplies).values(replyRows.slice(i, i + 25))
  }
  console.log(`  Seeded ${emailRows.length} emails, ${replyRows.length} replies`)
}

async function main() {
  const customerId = await getDevCustomerId()
  console.log(`Dev customer: ${customerId}`)

  console.log('Cleaning prior seeds…')
  await cleanup(customerId)

  if (CLEANUP) {
    console.log('Cleanup-only mode, done.')
    return
  }

  const plan = buildPlan(customerId)
  console.log(`Plan: ${plan.length} subscribers across ${new Set(plan.map((s) => s.bucketTag)).size} buckets`)

  console.log('Inserting subscribers…')
  const idByEmail = await seedSubscribers(plan)
  console.log(`  Inserted ${idByEmail.size} subscribers`)

  console.log('Inserting events…')
  await seedEvents(plan, idByEmail, customerId)

  console.log('Inserting emails and replies…')
  await seedEmailsAndReplies(plan, idByEmail)

  console.log('\nDone. Visit http://localhost:3000/admin/ai-quality to verify.')
  console.log('Re-run with --cleanup to remove everything.')
}

main().catch((e) => {
  console.error('Seed failed:', e)
  process.exit(1)
})

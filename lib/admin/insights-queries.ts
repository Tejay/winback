/**
 * Insights (business) page data — redesigned around what WinbackFlow
 * actually is: a payment-recovery + cancellation-winback SaaS on flat-tier
 * pricing. Answers three founder questions:
 *
 *   §1 Platform revenue  — are we making money?      (our own MRR)
 *   §2 Acquisition funnel — are we growing?           (signup → activated → paid)
 *   §3 Value delivered   — is the product working?    ($ recovered, recovery rate)
 *
 * Self-contained on purpose — does NOT reuse buildOverviewRollup so the Now
 * page's 30s poll and this load-once review page evolve independently. All
 * queries hit existing indexes; the page is load-once so cost is a non-issue.
 *
 * Every figure here is designed to drill down to a real list (see the
 * `drill` hrefs wired in insights-client.tsx → customers/subscribers/events
 * filters added in the same PR).
 */

import { and, eq, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { churnedSubscribers, customers, recoveries, users, wbEvents } from '../schema'
import { TIERS } from '@/src/winback/lib/billing-config'
import { mrrRecoveredWeeklyTrend, detectStripeMode } from './billing-queries'

export type InsightsWindow = '7d' | '30d' | '90d'

const DAY_MS = 24 * 60 * 60 * 1000

function windowSince(w: InsightsWindow): Date {
  const days = w === '7d' ? 7 : w === '90d' ? 90 : 30
  return new Date(Date.now() - days * DAY_MS)
}

/** Monthly price (cents) for a billed tier. Custom is handled separately. */
const TIER_PRICE_CENTS: Record<string, number | null> = Object.fromEntries(
  TIERS.map((t) => [t.key, t.priceUsdMinor]),
)

export interface InsightsData {
  window: InsightsWindow
  stripeMode: 'test' | 'live'

  /** §1 — WinbackFlow's own subscription revenue. */
  platform: {
    /** Σ(tier price × active subs) + custom rates. Enterprise excluded (sales-priced). */
    mrrCents: number
    payingMerchants: number
    /** Enterprise subs have no list price — surfaced separately so MRR isn't understated silently. */
    enterpriseMerchants: number
    tierCounts: { starter: number; growth: number; scale: number; enterprise: number; custom: number }
    arpaCents: number
    subsAddedInWindow: number
    subsCanceledInWindow: number
    reactivationsInWindow: number
  }

  /** §2 — acquisition funnel + pilots. */
  funnel: {
    totalMerchants: number
    activated: number
    paying: number
    stuckAtPaywall: number
    signupsInWindow: number
    conversionsInWindow: number
    activePilots: number
    pilotsEverIssued: number
    pilotsConverted: number
  }

  /** §3 — value delivered to merchants (proves the product works). */
  value: {
    recoveredCentsInWindow: number
    recoveredAllTimeCents: number
    recoveriesByAttribution: {
      strong:  { n: number; cents: number }
      weak:    { n: number; cents: number }
      organic: { n: number; cents: number }
    }
    /** Lifetime: recovered ÷ (recovered + lost). null if no terminal outcomes yet. */
    recoveryRatePct: number | null
    recoveredCount: number
    lostCount: number
    /** Which product mode drives value — win-back (voluntary cancel) vs card-save (failed payment). */
    byMode: {
      winBack:  { n: number; cents: number }
      cardSave: { n: number; cents: number }
    }
    /** Recovery engine funnel over the window. */
    engine: { ingested: number; contacted: number; recovered: number }
  }

  /** 13-week MRR-recovered trend (rescued from the retired /admin/billing). */
  mrrTrend: Array<{ week: string; attributionType: string; cents: number; n: number }>
}

// --- small count helpers (self-contained) --------------------------------

async function countEventsSince(name: string, since: Date): Promise<number> {
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, name), gte(wbEvents.createdAt, since)))
  return row?.n ?? 0
}

// --- main builder --------------------------------------------------------

export async function buildInsights(window: InsightsWindow = '30d'): Promise<InsightsData> {
  const since = windowSince(window)
  const now = new Date()
  const db = getDbReadOnly()

  const [
    tierRows,
    subsAddedInWindow,
    subsCanceledInWindow,
    reactivationsInWindow,
    totalMerchants,
    activated,
    paying,
    stuckAtPaywall,
    signupsInWindow,
    conversionsInWindow,
    activePilots,
    pilotsEverIssued,
    pilotsConverted,
    recoveredCentsInWindow,
    recoveredAllTimeCents,
    attributionRows,
    recoveredCount,
    lostCount,
    modeRows,
    engineIngested,
    engineContacted,
    engineRecovered,
    mrrTrend,
  ] = await Promise.all([
    // Platform MRR building blocks: tier counts + custom-rate sum for paying merchants.
    db.select({
      tier: customers.billedTier,
      n: sql<number>`count(*)::int`,
      customCents: sql<number>`coalesce(sum(${customers.customMonthlyCents}), 0)::bigint`,
    })
      .from(customers)
      .where(isNotNull(customers.stripeSubscriptionId))
      .groupBy(customers.billedTier),

    countEventsSince('platform_subscription_created', since),
    countEventsSince('platform_subscription_canceled', since),
    countEventsSince('platform_subscription_reactivated', since),

    db.select({ n: sql<number>`count(*)::int` }).from(customers).then((r) => r[0]?.n ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(customers).where(isNotNull(customers.activatedAt)).then((r) => r[0]?.n ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(customers).where(isNotNull(customers.stripeSubscriptionId)).then((r) => r[0]?.n ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(customers).where(and(
      isNotNull(customers.activatedAt),
      isNull(customers.stripeSubscriptionId),
      or(isNull(customers.pilotUntil), lt(customers.pilotUntil, now)),
    )).then((r) => r[0]?.n ?? 0),

    db.select({ n: sql<number>`count(*)::int` }).from(users).where(gte(users.createdAt, since)).then((r) => r[0]?.n ?? 0),
    countEventsSince('platform_subscription_created', since),

    db.select({ n: sql<number>`count(*)::int` }).from(customers).where(and(
      isNotNull(customers.pilotUntil),
      sql`${customers.pilotUntil} > ${now}`,
    )).then((r) => r[0]?.n ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(customers).where(isNotNull(customers.pilotUntil)).then((r) => r[0]?.n ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(customers).where(and(
      isNotNull(customers.pilotUntil),
      isNotNull(customers.stripeSubscriptionId),
    )).then((r) => r[0]?.n ?? 0),

    // §3 value
    db.select({ cents: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::bigint` })
      .from(recoveries).where(gte(recoveries.recoveredAt, since)).then((r) => Number(r[0]?.cents ?? 0)),
    db.select({ cents: sql<number>`coalesce(sum(${customers.cumulativeRevenueSavedCents}), 0)::bigint` })
      .from(customers).then((r) => Number(r[0]?.cents ?? 0)),
    db.select({
      type: sql<string>`coalesce(${recoveries.attributionType}, 'organic')`,
      n: sql<number>`count(*)::int`,
      cents: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::bigint`,
    }).from(recoveries).where(gte(recoveries.recoveredAt, since))
      .groupBy(sql`coalesce(${recoveries.attributionType}, 'organic')`),

    db.select({ n: sql<number>`count(*)::int` }).from(churnedSubscribers).where(eq(churnedSubscribers.status, 'recovered')).then((r) => r[0]?.n ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(churnedSubscribers).where(eq(churnedSubscribers.status, 'lost')).then((r) => r[0]?.n ?? 0),

    db.select({
      mode: sql<string>`coalesce(${recoveries.recoveryType}, 'unknown')`,
      n: sql<number>`count(*)::int`,
      cents: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::bigint`,
    }).from(recoveries).where(gte(recoveries.recoveredAt, since))
      .groupBy(sql`coalesce(${recoveries.recoveryType}, 'unknown')`),

    // Engine funnel (window, by churn ingest time)
    db.select({ n: sql<number>`count(*)::int` }).from(churnedSubscribers).where(gte(churnedSubscribers.createdAt, since)).then((r) => r[0]?.n ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(churnedSubscribers).where(and(
      gte(churnedSubscribers.createdAt, since),
      sql`${churnedSubscribers.status} in ('contacted', 'recovered', 'lost')`,
    )).then((r) => r[0]?.n ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(churnedSubscribers).where(and(
      gte(churnedSubscribers.createdAt, since),
      eq(churnedSubscribers.status, 'recovered'),
    )).then((r) => r[0]?.n ?? 0),

    mrrRecoveredWeeklyTrend(13),
  ])

  // Reduce tier rows → counts + MRR
  const tierCounts = { starter: 0, growth: 0, scale: 0, enterprise: 0, custom: 0 }
  let mrrCents = 0
  for (const r of tierRows) {
    const key = (r.tier ?? '') as keyof typeof tierCounts
    if (key in tierCounts) tierCounts[key] = r.n
    if (key === 'custom') {
      mrrCents += Number(r.customCents)            // custom rate sum
    } else {
      const price = TIER_PRICE_CENTS[key]
      if (price) mrrCents += price * r.n            // starter/growth/scale; enterprise price is null
    }
  }
  const payingMerchants = tierCounts.starter + tierCounts.growth + tierCounts.scale + tierCounts.enterprise + tierCounts.custom
  const arpaCents = payingMerchants > 0 ? Math.round(mrrCents / payingMerchants) : 0

  // Attribution rows → fixed shape. Catch-all into 'organic' so the split
  // always sums to the windowed total (mirrors recoveriesTodaySplit in
  // rollups.ts: strong / weak / else→organic). 'else' covers null (already
  // coalesced) and any unexpected value.
  const recoveriesByAttribution = {
    strong:  { n: 0, cents: 0 },
    weak:    { n: 0, cents: 0 },
    organic: { n: 0, cents: 0 },
  }
  for (const r of attributionRows) {
    const cents = Number(r.cents)
    const bucket = r.type === 'strong' ? recoveriesByAttribution.strong
                 : r.type === 'weak'   ? recoveriesByAttribution.weak
                 : recoveriesByAttribution.organic
    bucket.n += r.n
    bucket.cents += cents
  }

  // Mode rows → win-back vs card-save. CANONICAL bucketing (see
  // stats.ts:aggregateRecoveryRows): card_save → card-save; win_back OR
  // null OR anything-else → win-back. Accumulate so legacy null/unknown
  // rows land in win-back and the split always sums to the total.
  const byMode = { winBack: { n: 0, cents: 0 }, cardSave: { n: 0, cents: 0 } }
  for (const r of modeRows) {
    const cents = Number(r.cents)
    const bucket = r.mode === 'card_save' ? byMode.cardSave : byMode.winBack
    bucket.n += r.n
    bucket.cents += cents
  }

  const terminal = recoveredCount + lostCount
  const recoveryRatePct = terminal > 0 ? Math.round((recoveredCount / terminal) * 1000) / 10 : null

  return {
    window,
    stripeMode: detectStripeMode(),
    platform: {
      mrrCents,
      payingMerchants,
      enterpriseMerchants: tierCounts.enterprise,
      tierCounts,
      arpaCents,
      subsAddedInWindow,
      subsCanceledInWindow,
      reactivationsInWindow,
    },
    funnel: {
      totalMerchants,
      activated,
      paying,
      stuckAtPaywall,
      signupsInWindow,
      conversionsInWindow,
      activePilots,
      pilotsEverIssued,
      pilotsConverted,
    },
    value: {
      recoveredCentsInWindow,
      recoveredAllTimeCents,
      recoveriesByAttribution,
      recoveryRatePct,
      recoveredCount,
      lostCount,
      byMode,
      engine: { ingested: engineIngested, contacted: engineContacted, recovered: engineRecovered },
    },
    mrrTrend,
  }
}

/**
 * Spec 26 (original) + Spec 78 (redesign) — Aggregation queries for
 * /admin/ai-quality.
 *
 * Seven blocks under Spec 78:
 *   1. Calibration (predictions joined to outcomes on a settled cohort)
 *   2. Week-vs-baseline drift detection
 *   3. Cancellation-category mix + 7d shift
 *   4. Smart-ranked auto-lost audit
 *   5. Smart-ranked handoff audit (with founder-resolution column)
 *   6. Low-confidence classifications
 *   7. Re-engagement match rate
 *
 * All read-only; all hit existing indexes. No schema changes from
 * Spec 78 — pure aggregation.
 */

import { sql, and, eq, gte, isNotNull, desc, lt } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { wbEvents, churnedSubscribers, customers, users } from '../schema'

const DAY_MS = 24 * 60 * 60 * 1000

function nDaysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS)
}

function fillDailyBuckets(
  rows: Array<{ day: string; n: number }>,
  days: number,
): Array<{ day: string; n: number }> {
  const since = new Date(Date.now() - (days - 1) * DAY_MS)
  since.setUTCHours(0, 0, 0, 0)
  const byDay = new Map(rows.map((r) => [r.day, r.n]))
  const out: Array<{ day: string; n: number }> = []
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * DAY_MS)
    const key = d.toISOString().slice(0, 10)
    out.push({ day: key, n: byDay.get(key) ?? 0 })
  }
  return out
}

/**
 * Block A — Handoff volume trend (30 days).
 * Daily count of `founder_handoff_triggered`. Padded so every day in the
 * window has an entry (zeros for quiet days).
 */
export async function handoffVolumeTrend(days = 30): Promise<Array<{ day: string; n: number }>> {
  const since = nDaysAgo(days - 1)
  since.setUTCHours(0, 0, 0, 0)
  const rows = await getDbReadOnly()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${wbEvents.createdAt}), 'YYYY-MM-DD')`,
      n:   sql<number>`count(*)::int`,
    })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, 'founder_handoff_triggered'), gte(wbEvents.createdAt, since)))
    .groupBy(sql`date_trunc('day', ${wbEvents.createdAt})`)
  return fillDailyBuckets(rows, days)
}

/**
 * Companion to handoffVolumeTrend — silent-close trend (subscriber_auto_lost).
 * Used alongside handoffs to spot the bad failure mode where AI stops
 * escalating but starts auto-losing more.
 */
export async function autoLostTrend(days = 30): Promise<Array<{ day: string; n: number }>> {
  const since = nDaysAgo(days - 1)
  since.setUTCHours(0, 0, 0, 0)
  const rows = await getDbReadOnly()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${wbEvents.createdAt}), 'YYYY-MM-DD')`,
      n:   sql<number>`count(*)::int`,
    })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, 'subscriber_auto_lost'), gte(wbEvents.createdAt, since)))
    .groupBy(sql`date_trunc('day', ${wbEvents.createdAt})`)
  return fillDailyBuckets(rows, days)
}

/**
 * Block B — Recovery-likelihood histogram.
 * Distribution of recovery_likelihood for subscribers classified in the
 * last `days` days. Returns three buckets even when zero (so the chart
 * renders a stable shape).
 */
export async function recoveryLikelihoodHistogram(
  days = 30,
): Promise<{ high: number; medium: number; low: number; total: number }> {
  const since = nDaysAgo(days)
  const rows = await getDbReadOnly()
    .select({
      likelihood: churnedSubscribers.recoveryLikelihood,
      n:          sql<number>`count(*)::int`,
    })
    .from(churnedSubscribers)
    .where(and(
      isNotNull(churnedSubscribers.recoveryLikelihood),
      gte(churnedSubscribers.createdAt, since),
    ))
    .groupBy(churnedSubscribers.recoveryLikelihood)

  const out = { high: 0, medium: 0, low: 0, total: 0 }
  for (const r of rows) {
    if (r.likelihood === 'high')   out.high   = r.n
    if (r.likelihood === 'medium') out.medium = r.n
    if (r.likelihood === 'low')    out.low    = r.n
    out.total += r.n
  }
  return out
}

/**
 * Block C — Tier distribution over time.
 * Daily counts split by tier (1–4) for the last `days` days. Sparse —
 * only days with at least one classification appear; the client fills.
 */
export async function tierDistribution(
  days = 30,
): Promise<Array<{ day: string; tier: number; n: number }>> {
  const since = nDaysAgo(days)
  const rows = await getDbReadOnly()
    .select({
      day:  sql<string>`to_char(date_trunc('day', ${churnedSubscribers.createdAt}), 'YYYY-MM-DD')`,
      tier: churnedSubscribers.tier,
      n:    sql<number>`count(*)::int`,
    })
    .from(churnedSubscribers)
    .where(and(
      gte(churnedSubscribers.createdAt, since),
      isNotNull(churnedSubscribers.tier),
    ))
    .groupBy(sql`date_trunc('day', ${churnedSubscribers.createdAt})`, churnedSubscribers.tier)
  return rows
    .filter((r): r is { day: string; tier: number; n: number } => r.tier !== null)
    .map((r) => ({ day: r.day, tier: r.tier as number, n: r.n }))
}

export interface HandoffAuditRow {
  id: string
  name: string | null
  email: string | null
  handoffReasoning: string | null
  recoveryLikelihood: string | null
  mrrCents: number
  cancellationReason: string | null
  founderHandoffAt: Date | null
  productName: string | null
  customerEmail: string | null
}

/**
 * Block D — Hand-off reasoning audit (last N).
 * Most recent handoffs joined with the customer's identity for context.
 * Each row links to the cross-customer subscriber drawer (Phase 1).
 */
export async function handoffAudit(limit = 50): Promise<HandoffAuditRow[]> {
  const rows = await getDbReadOnly()
    .select({
      id:                 churnedSubscribers.id,
      name:               churnedSubscribers.name,
      email:              churnedSubscribers.email,
      handoffReasoning:   churnedSubscribers.handoffReasoning,
      recoveryLikelihood: churnedSubscribers.recoveryLikelihood,
      mrrCents:           churnedSubscribers.mrrCents,
      cancellationReason: churnedSubscribers.cancellationReason,
      founderHandoffAt:   churnedSubscribers.founderHandoffAt,
      productName:        customers.productName,
      customerEmail:      users.email,
    })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(customers.id, churnedSubscribers.customerId))
    .innerJoin(users, eq(users.id, customers.userId))
    .where(isNotNull(churnedSubscribers.founderHandoffAt))
    .orderBy(desc(churnedSubscribers.founderHandoffAt))
    .limit(limit)
  return rows
}

// ---------------------------------------------------------------------------
// Spec 78 — Phase A queries
// ---------------------------------------------------------------------------

export interface DriftMetric {
  /** Display label shown in the table row. */
  label: string
  /** Value computed over the last 7 days. */
  last7d: number
  /** Value computed over the prior 23 days (8-30 days ago). */
  prior23d: number
  /**
   * Percentage delta from `prior23d` to `last7d`. `null` when the prior
   * window is zero — division by zero is meaningless, and the UI shows
   * the absolute counts instead.
   */
  deltaPct: number | null
  /**
   * True when `|deltaPct| >= 20` AND the metric movement is in the bad
   * direction (e.g., low-likelihood share rising is bad; rising
   * classification volume is not flagged because more activity isn't
   * a quality issue).
   */
  flagged: boolean
  /** UI hint for value rendering — share metrics render as "8%", counts as "12". */
  format: 'count' | 'rate_per_day' | 'percent' | 'decimal'
}

/**
 * Block 2 — Week-vs-baseline drift detection.
 *
 * Six metrics, each computed over (a) the last 7 days and (b) the
 * preceding 23 days (i.e., the 30-day window minus the most recent 7).
 * Deltas of ±20% on quality-bearing metrics are flagged.
 *
 * Implementation: two raw-SQL aggregations (one over
 * `wb_churned_subscribers`, one over `wb_events` for auto-lost) so we
 * get all FILTER-clause counts in one round-trip per table. Drizzle's
 * conditional aggregates are awkward to chain; raw SQL is clearer here.
 */
export async function weekVsBaseline(): Promise<{ metrics: DriftMetric[] }> {
  const db = getDbReadOnly()

  // Conditional aggregates on the subscriber table — all metrics that
  // are properties of a classified subscriber (volume, tier-4 share,
  // handoff share, low-likelihood share, median confidence).
  const subAggResult = await db.execute(sql`
    SELECT
      count(*) FILTER (
        WHERE classified_at >= now() - interval '7 days'
      )::int AS class_7d,
      count(*) FILTER (
        WHERE classified_at >= now() - interval '30 days'
          AND classified_at <  now() - interval '7 days'
      )::int AS class_23d,
      count(*) FILTER (
        WHERE tier = 4
          AND classified_at >= now() - interval '7 days'
      )::int AS tier4_7d,
      count(*) FILTER (
        WHERE tier = 4
          AND classified_at >= now() - interval '30 days'
          AND classified_at <  now() - interval '7 days'
      )::int AS tier4_23d,
      count(*) FILTER (
        WHERE recovery_likelihood = 'low'
          AND classified_at >= now() - interval '7 days'
      )::int AS low_7d,
      count(*) FILTER (
        WHERE recovery_likelihood = 'low'
          AND classified_at >= now() - interval '30 days'
          AND classified_at <  now() - interval '7 days'
      )::int AS low_23d,
      count(*) FILTER (
        WHERE founder_handoff_at >= now() - interval '7 days'
      )::int AS handoff_7d,
      count(*) FILTER (
        WHERE founder_handoff_at >= now() - interval '30 days'
          AND founder_handoff_at <  now() - interval '7 days'
      )::int AS handoff_23d,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY confidence::float)
        FILTER (
          WHERE classified_at >= now() - interval '7 days'
            AND confidence IS NOT NULL
        ) AS conf_med_7d,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY confidence::float)
        FILTER (
          WHERE classified_at >= now() - interval '30 days'
            AND classified_at <  now() - interval '7 days'
            AND confidence IS NOT NULL
        ) AS conf_med_23d
    FROM wb_churned_subscribers
  `)
  const subAgg = (subAggResult.rows[0] ?? {}) as Record<string, number | string | null>

  // Auto-lost is an event, not a column on the subscriber.
  const eventAggResult = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS al_7d,
      count(*) FILTER (
        WHERE created_at >= now() - interval '30 days'
          AND created_at <  now() - interval '7 days'
      )::int AS al_23d
    FROM wb_events
    WHERE name = 'subscriber_auto_lost'
  `)
  const eventAgg = (eventAggResult.rows[0] ?? {}) as Record<string, number | string | null>

  const numOr = (v: unknown, fallback: number): number =>
    typeof v === 'number' ? v
      : typeof v === 'string' ? (Number.isFinite(parseFloat(v)) ? parseFloat(v) : fallback)
      : fallback

  const class7d   = numOr(subAgg.class_7d, 0)
  const class23d  = numOr(subAgg.class_23d, 0)
  const tier47d   = numOr(subAgg.tier4_7d, 0)
  const tier423d  = numOr(subAgg.tier4_23d, 0)
  const low7d     = numOr(subAgg.low_7d, 0)
  const low23d    = numOr(subAgg.low_23d, 0)
  const handoff7d = numOr(subAgg.handoff_7d, 0)
  const handoff23d= numOr(subAgg.handoff_23d, 0)
  const conf7d    = numOr(subAgg.conf_med_7d, 0)
  const conf23d   = numOr(subAgg.conf_med_23d, 0)
  const al7d      = numOr(eventAgg.al_7d, 0)
  const al23d     = numOr(eventAgg.al_23d, 0)

  function pctDelta(now: number, prior: number): number | null {
    if (prior <= 0) return null
    return Math.round(((now - prior) / prior) * 100)
  }
  function pctShare(num: number, denom: number): number {
    if (denom <= 0) return 0
    return (num / denom) * 100
  }
  // A metric is "flagged" when the move is in the BAD direction AND the
  // delta magnitude is ≥20%. Increased classification volume isn't bad,
  // so we don't flag that direction. Decreased handoff share IS flagged
  // (AI dropping escalations). Increased Tier-4, increased low-likelihood
  // share, decreased confidence, increased auto-lost rate — all flagged.
  function flag(delta: number | null, badDirection: 'up' | 'down' | 'either'): boolean {
    if (delta === null) return false
    const mag = Math.abs(delta)
    if (mag < 20) return false
    if (badDirection === 'either') return true
    if (badDirection === 'up')   return delta > 0
    if (badDirection === 'down') return delta < 0
    return false
  }

  const classPerDay7d = class7d / 7
  const classPerDay23d = class23d / 23
  const tier4Share7d = pctShare(tier47d, class7d)
  const tier4Share23d = pctShare(tier423d, class23d)
  const handoffShare7d = pctShare(handoff7d, class7d)
  const handoffShare23d = pctShare(handoff23d, class23d)
  const lowShare7d = pctShare(low7d, class7d)
  const lowShare23d = pctShare(low23d, class23d)
  const alPerDay7d = al7d / 7
  const alPerDay23d = al23d / 23

  const metrics: DriftMetric[] = [
    {
      label: 'Classifications / day',
      last7d: classPerDay7d,
      prior23d: classPerDay23d,
      deltaPct: pctDelta(classPerDay7d, classPerDay23d),
      flagged: false, // volume itself isn't a quality signal
      format: 'rate_per_day',
    },
    {
      label: 'Tier-4 share',
      last7d: tier4Share7d,
      prior23d: tier4Share23d,
      deltaPct: pctDelta(tier4Share7d, tier4Share23d),
      flagged: flag(pctDelta(tier4Share7d, tier4Share23d), 'up'),
      format: 'percent',
    },
    {
      label: 'Handoff share',
      last7d: handoffShare7d,
      prior23d: handoffShare23d,
      deltaPct: pctDelta(handoffShare7d, handoffShare23d),
      flagged: flag(pctDelta(handoffShare7d, handoffShare23d), 'down'),
      format: 'percent',
    },
    {
      label: 'Auto-lost / day',
      last7d: alPerDay7d,
      prior23d: alPerDay23d,
      deltaPct: pctDelta(alPerDay7d, alPerDay23d),
      flagged: flag(pctDelta(alPerDay7d, alPerDay23d), 'up'),
      format: 'rate_per_day',
    },
    {
      label: 'recoveryLikelihood=low share',
      last7d: lowShare7d,
      prior23d: lowShare23d,
      deltaPct: pctDelta(lowShare7d, lowShare23d),
      flagged: flag(pctDelta(lowShare7d, lowShare23d), 'up'),
      format: 'percent',
    },
    {
      label: 'Median confidence',
      last7d: conf7d,
      prior23d: conf23d,
      deltaPct: pctDelta(conf7d, conf23d),
      flagged: flag(pctDelta(conf7d, conf23d), 'down'),
      format: 'decimal',
    },
  ]
  return { metrics }
}

export interface CategoryMixRow {
  category: string
  count30d: number
  pct30d: number       // percentage share over the 30d window (0-100)
  pctShift7d: number   // shift in percentage points (last 7d share - prior 23d share)
}

/**
 * Block 3 — Cancellation category mix.
 *
 * 30-day distribution of `cancellation_category` plus the
 * percentage-point shift comparing the last 7 days against the prior
 * 23 days. A "Feature +3pp" row means feature-category cancellations
 * grew from ~X% baseline to (X+3)% in the most recent week — usually
 * meaningful even when the absolute volume is small.
 */
export async function cancellationCategoryMix(): Promise<{
  rows: CategoryMixRow[]
  total30d: number
}> {
  const db = getDbReadOnly()
  const result = await db.execute(sql`
    SELECT
      cancellation_category AS category,
      count(*) FILTER (
        WHERE classified_at >= now() - interval '30 days'
      )::int AS n_30d,
      count(*) FILTER (
        WHERE classified_at >= now() - interval '7 days'
      )::int AS n_7d,
      count(*) FILTER (
        WHERE classified_at >= now() - interval '30 days'
          AND classified_at <  now() - interval '7 days'
      )::int AS n_23d
    FROM wb_churned_subscribers
    WHERE cancellation_category IS NOT NULL
      AND classified_at >= now() - interval '30 days'
    GROUP BY cancellation_category
  `)
  const rows = (result.rows ?? []) as Array<Record<string, unknown>>
  const total30d = rows.reduce((acc, r) => acc + Number(r.n_30d ?? 0), 0)
  const total7d  = rows.reduce((acc, r) => acc + Number(r.n_7d  ?? 0), 0)
  const total23d = rows.reduce((acc, r) => acc + Number(r.n_23d ?? 0), 0)
  const out: CategoryMixRow[] = rows.map((r) => {
    const n30 = Number(r.n_30d ?? 0)
    const n7  = Number(r.n_7d  ?? 0)
    const n23 = Number(r.n_23d ?? 0)
    const share30 = total30d > 0 ? (n30 / total30d) * 100 : 0
    const share7  = total7d  > 0 ? (n7  / total7d)  * 100 : 0
    const share23 = total23d > 0 ? (n23 / total23d) * 100 : 0
    return {
      category: String(r.category),
      count30d: n30,
      pct30d: share30,
      pctShift7d: share7 - share23,
    }
  })
  // Highest 30d share first
  out.sort((a, b) => b.pct30d - a.pct30d)
  return { rows: out, total30d }
}

export interface LowConfidenceRow {
  id: string
  classifiedAt: Date | null
  name: string | null
  email: string | null
  tier: number | null
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
  confidence: number | null
  cancellationReason: string | null
  cancellationCategory: string | null
  productName: string | null
  customerEmail: string | null
}

/**
 * Block 6 — Low-confidence classifications (most recent 25 where
 * `confidence < 0.4`). These are the cases the AI itself flagged it
 * was hedging on; reading them concentrates the prompt's weak spots.
 */
export async function lowConfidenceClassifications(limit = 25): Promise<LowConfidenceRow[]> {
  const db = getDbReadOnly()
  const rows = await db
    .select({
      id:                   churnedSubscribers.id,
      classifiedAt:         churnedSubscribers.classifiedAt,
      name:                 churnedSubscribers.name,
      email:                churnedSubscribers.email,
      tier:                 churnedSubscribers.tier,
      recoveryLikelihood:   churnedSubscribers.recoveryLikelihood,
      confidence:           churnedSubscribers.confidence,
      cancellationReason:   churnedSubscribers.cancellationReason,
      cancellationCategory: churnedSubscribers.cancellationCategory,
      productName:          customers.productName,
      customerEmail:        users.email,
    })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(customers.id, churnedSubscribers.customerId))
    .innerJoin(users, eq(users.id, customers.userId))
    .where(and(
      isNotNull(churnedSubscribers.classifiedAt),
      isNotNull(churnedSubscribers.confidence),
      sql`${churnedSubscribers.confidence}::float < 0.4`,
    ))
    .orderBy(desc(churnedSubscribers.classifiedAt))
    .limit(limit)
  return rows.map((r) => ({
    ...r,
    confidence: r.confidence !== null ? parseFloat(String(r.confidence)) : null,
    recoveryLikelihood: r.recoveryLikelihood as 'high' | 'medium' | 'low' | null,
  }))
}

// ---------------------------------------------------------------------------
// Spec 26 / pre-78 queries (kept until Phase D removes the old blocks)
// ---------------------------------------------------------------------------

export interface AutoLostAuditRow {
  id: string
  createdAt: Date
  customerId: string | null
  customerEmail: string | null
  productName: string | null
  properties: Record<string, unknown>
}

/**
 * Block E — Silent-close audit (last N subscriber_auto_lost events).
 * Surfaces the AI's reasoning at the moment it gave up, so we can spot
 * cases that should have been escalated.
 */
export async function autoLostAudit(limit = 50): Promise<AutoLostAuditRow[]> {
  const rows = await getDbReadOnly()
    .select({
      id:            wbEvents.id,
      createdAt:     wbEvents.createdAt,
      customerId:    wbEvents.customerId,
      customerEmail: users.email,
      productName:   customers.productName,
      properties:    wbEvents.properties,
    })
    .from(wbEvents)
    .leftJoin(customers, eq(customers.id, wbEvents.customerId))
    .leftJoin(users, eq(users.id, customers.userId))
    .where(eq(wbEvents.name, 'subscriber_auto_lost'))
    .orderBy(desc(wbEvents.createdAt))
    .limit(limit)
  return rows
}

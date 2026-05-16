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
// Spec 78 — Phase B queries (calibration + re-engagement match rate)
// ---------------------------------------------------------------------------

export interface LikelihoodCalibrationRow {
  likelihood: 'high' | 'medium' | 'low'
  n: number
  recovered: number
  autoLost: number
  lostOther: number   // status='lost' but not auto-lost (e.g. expiry sweep)
  stillOpen: number
}

export interface HandoffConversionRow {
  cohort: 'handoff' | 'non_handoff'
  n: number
  recovered: number
}

export interface AutoLostReversalSummary {
  /** Total auto-lost cases in cohort. */
  n: number
  /** Of those, how many ended up with status='recovered'. */
  reversed: number
  /** Sample of the reversed cases for the UI to link to. */
  reversedSample: Array<{
    subscriberId: string
    name: string | null
    email: string | null
    recoveredAt: Date | null
  }>
}

export interface CalibrationCohort {
  /** Inclusive lower bound (oldest classifiedAt in the window). */
  startDate: Date
  /** Inclusive upper bound (newest classifiedAt in the window). */
  endDate: Date
  /** Total subscribers classified within the cohort window. */
  total: number
  /** Per-likelihood-bucket outcome distribution. */
  byLikelihood: LikelihoodCalibrationRow[]
  /** Handoff vs. non-handoff recovery rate within the cohort. */
  handoffConversion: HandoffConversionRow[]
  /** Auto-lost reversal — measurable false-negative rate. */
  autoLostReversal: AutoLostReversalSummary
}

/**
 * Block 1 — Outcome-grounded calibration.
 *
 * The "settled cohort" is subscribers classified ≥30 days ago and ≤90
 * days ago. ≥30 because handoffs that recovered average 14-21 days end
 * to end and we want the tail; ≤90 because older data is "old prompt
 * era" and dilutes the signal from recent prompt changes.
 *
 * Three derived tables:
 *   - recovery rate by predicted likelihood (the calibration test —
 *     should be monotonic: high > medium > low)
 *   - handoff vs. non-handoff recovery (does escalation pay off?)
 *   - auto-lost reversal (any cases the AI gave up on but recovered
 *     anyway? = confirmed false negatives)
 */
export async function calibrationCohort(
  cohortStartDaysAgo = 90,
  cohortEndDaysAgo   = 30,
): Promise<CalibrationCohort> {
  const db = getDbReadOnly()

  const startDate = nDaysAgo(cohortStartDaysAgo)
  const endDate   = nDaysAgo(cohortEndDaysAgo)

  // One big aggregate over the cohort joined with the auto-lost
  // subscriber set. Single round-trip; the LEFT JOIN against the
  // DISTINCT auto-lost subscriber CTE is the cleanest way to FILTER
  // by event presence without correlated subqueries.
  const calibrationResult = await db.execute(sql`
    WITH cohort AS (
      SELECT
        s.id,
        s.recovery_likelihood,
        s.status,
        s.founder_handoff_at
      FROM wb_churned_subscribers s
      WHERE s.classified_at >= now() - (${cohortStartDaysAgo}::int * interval '1 day')
        AND s.classified_at <  now() - (${cohortEndDaysAgo}::int * interval '1 day')
    ),
    auto_lost_subs AS (
      SELECT DISTINCT (properties->>'subscriberId')::uuid AS subscriber_id
      FROM wb_events
      WHERE name = 'subscriber_auto_lost'
        AND created_at >= now() - (${cohortStartDaysAgo + 30}::int * interval '1 day')
    )
    SELECT
      c.recovery_likelihood AS likelihood,
      count(*)::int AS n,
      count(*) FILTER (WHERE c.status = 'recovered')::int                  AS recovered,
      count(*) FILTER (WHERE al.subscriber_id IS NOT NULL)::int            AS auto_lost,
      count(*) FILTER (WHERE c.status = 'lost' AND al.subscriber_id IS NULL)::int AS lost_other,
      count(*) FILTER (WHERE c.status IN ('pending', 'contacted'))::int    AS still_open
    FROM cohort c
    LEFT JOIN auto_lost_subs al ON al.subscriber_id = c.id
    WHERE c.recovery_likelihood IS NOT NULL
    GROUP BY c.recovery_likelihood
  `)

  const calRows = (calibrationResult.rows ?? []) as Array<Record<string, unknown>>
  const byLikelihood: LikelihoodCalibrationRow[] = (['high', 'medium', 'low'] as const).map((lh) => {
    const r = calRows.find((row) => row.likelihood === lh)
    return {
      likelihood: lh,
      n:         Number(r?.n         ?? 0),
      recovered: Number(r?.recovered ?? 0),
      autoLost:  Number(r?.auto_lost ?? 0),
      lostOther: Number(r?.lost_other?? 0),
      stillOpen: Number(r?.still_open?? 0),
    }
  })

  // Handoff vs. non-handoff conversion within the same cohort.
  const handoffResult = await db.execute(sql`
    SELECT
      CASE WHEN s.founder_handoff_at IS NOT NULL THEN 'handoff' ELSE 'non_handoff' END AS cohort,
      count(*)::int AS n,
      count(*) FILTER (WHERE s.status = 'recovered')::int AS recovered
    FROM wb_churned_subscribers s
    WHERE s.classified_at >= now() - (${cohortStartDaysAgo}::int * interval '1 day')
      AND s.classified_at <  now() - (${cohortEndDaysAgo}::int * interval '1 day')
    GROUP BY cohort
  `)

  const hRows = (handoffResult.rows ?? []) as Array<Record<string, unknown>>
  const handoffConversion: HandoffConversionRow[] = (['handoff', 'non_handoff'] as const).map((c) => {
    const r = hRows.find((row) => row.cohort === c)
    return {
      cohort: c,
      n:         Number(r?.n         ?? 0),
      recovered: Number(r?.recovered ?? 0),
    }
  })

  // Auto-lost reversal: subscribers who fired subscriber_auto_lost in
  // the cohort window AND have status='recovered' now. These are the
  // confirmed false negatives — read every one.
  const reversalResult = await db.execute(sql`
    WITH cohort_auto_lost AS (
      SELECT DISTINCT (e.properties->>'subscriberId')::uuid AS subscriber_id
      FROM wb_events e
      WHERE e.name = 'subscriber_auto_lost'
        AND e.created_at >= now() - (${cohortStartDaysAgo}::int * interval '1 day')
        AND e.created_at <  now() - (${cohortEndDaysAgo}::int * interval '1 day')
    )
    SELECT
      count(*)::int AS n,
      count(*) FILTER (WHERE s.status = 'recovered')::int AS reversed
    FROM cohort_auto_lost cal
    JOIN wb_churned_subscribers s ON s.id = cal.subscriber_id
  `)
  const revRow = (reversalResult.rows?.[0] ?? {}) as Record<string, unknown>
  const reversalN        = Number(revRow.n        ?? 0)
  const reversalReversed = Number(revRow.reversed ?? 0)

  // Pull a short sample so the UI can link to the actual cases.
  // Capped at 10 — these are the cards the supervisor should read.
  let reversedSample: AutoLostReversalSummary['reversedSample'] = []
  if (reversalReversed > 0) {
    const sampleResult = await db.execute(sql`
      WITH cohort_auto_lost AS (
        SELECT DISTINCT (e.properties->>'subscriberId')::uuid AS subscriber_id
        FROM wb_events e
        WHERE e.name = 'subscriber_auto_lost'
          AND e.created_at >= now() - (${cohortStartDaysAgo}::int * interval '1 day')
          AND e.created_at <  now() - (${cohortEndDaysAgo}::int * interval '1 day')
      )
      SELECT s.id AS subscriber_id, s.name, s.email, s.updated_at AS recovered_at
      FROM cohort_auto_lost cal
      JOIN wb_churned_subscribers s ON s.id = cal.subscriber_id
      WHERE s.status = 'recovered'
      ORDER BY s.updated_at DESC
      LIMIT 10
    `)
    reversedSample = ((sampleResult.rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      subscriberId: String(r.subscriber_id),
      name:         r.name  === null ? null : String(r.name ?? ''),
      email:        r.email === null ? null : String(r.email ?? ''),
      recoveredAt:  r.recovered_at ? new Date(String(r.recovered_at)) : null,
    }))
  }

  // Cohort total (for the header copy "n=287 classified between Mar 16 – Apr 15")
  const totalResult = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM wb_churned_subscribers s
    WHERE s.classified_at >= now() - (${cohortStartDaysAgo}::int * interval '1 day')
      AND s.classified_at <  now() - (${cohortEndDaysAgo}::int * interval '1 day')
  `)
  const total = Number((totalResult.rows?.[0] as Record<string, unknown> | undefined)?.n ?? 0)

  return {
    startDate,
    endDate,
    total,
    byLikelihood,
    handoffConversion,
    autoLostReversal: {
      n: reversalN,
      reversed: reversalReversed,
      reversedSample,
    },
  }
}

export interface ReengagementMatchRate {
  windowDays: number
  /** Eligible cohort — triggerNeedConfidence='high' classified within window. */
  eligible: number
  /** Eligible AND was emailed (has a wb_emails_sent row with type='reengagement'). */
  emailed: number
  /** Eligible AND `reengagement_expired_at` is set (9-month sweep terminated them). */
  expired: number
  /** Eligible AND neither emailed nor expired — still in the matcher window. */
  pending: number
}

/**
 * Block 7 — Re-engagement match rate.
 *
 * Of subscribers in the last `windowDays` days with
 * `triggerNeedConfidence='high'` (Spec 65 — eligible for matching),
 * what fraction were matched + emailed vs. expired without a match?
 *
 * Low match rate has two causes worth distinguishing:
 *   - AI's triggerNeed text is too vague for the LLM matcher
 *   - The merchant isn't shipping improvements that address subscriber asks
 */
export async function reengagementMatchRate(windowDays = 90): Promise<ReengagementMatchRate> {
  const db = getDbReadOnly()
  const result = await db.execute(sql`
    WITH eligible AS (
      SELECT s.id, s.reengagement_expired_at
      FROM wb_churned_subscribers s
      WHERE s.trigger_need_confidence = 'high'
        AND s.classified_at >= now() - (${windowDays}::int * interval '1 day')
    )
    SELECT
      count(*)::int AS eligible,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM wb_emails_sent es
          WHERE es.subscriber_id = e.id
            AND es.type = 'reengagement'
        )
      )::int AS emailed,
      count(*) FILTER (
        WHERE e.reengagement_expired_at IS NOT NULL
      )::int AS expired
    FROM eligible e
  `)
  const r = (result.rows?.[0] ?? {}) as Record<string, unknown>
  const eligible = Number(r.eligible ?? 0)
  const emailed  = Number(r.emailed  ?? 0)
  const expired  = Number(r.expired  ?? 0)
  // pending = eligible − emailed − expired, but a subscriber can be
  // both "emailed" AND "expired" if they were re-engaged and then
  // hit the 9-month sweep. Compute pending conservatively as
  // "neither emailed nor expired" rather than via subtraction.
  const pendingResult = await db.execute(sql`
    SELECT count(*)::int AS pending
    FROM wb_churned_subscribers s
    WHERE s.trigger_need_confidence = 'high'
      AND s.classified_at >= now() - (${windowDays}::int * interval '1 day')
      AND s.reengagement_expired_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM wb_emails_sent es
        WHERE es.subscriber_id = s.id
          AND es.type = 'reengagement'
      )
  `)
  const pending = Number((pendingResult.rows?.[0] as Record<string, unknown> | undefined)?.pending ?? 0)
  return { windowDays, eligible, emailed, expired, pending }
}

// ---------------------------------------------------------------------------
// Spec 78 — Phase C queries (smart-ranked audits)
// ---------------------------------------------------------------------------

export interface RankedAuditRow {
  subscriberId: string
  customerId: string | null
  name: string | null
  email: string | null
  productName: string | null
  customerEmail: string | null
  mrrCents: number
  tenureDays: number | null
  cancellationReason: string | null
  cancellationCategory: string | null
  recoveryLikelihood: 'high' | 'medium' | 'low' | null
  handoffReasoning: string | null
  replyCount: number
  billingPortalClicked: boolean
  interestScore: number
  /** Timestamp of the audit-relevant event (auto-lost event or handoff). */
  occurredAt: Date | null
}

export interface RankedHandoffRow extends RankedAuditRow {
  founderHandoffAt: Date | null
  founderHandoffResolvedAt: Date | null
  /** Derived state for the UI: open / stale / resolved + outcome. */
  resolutionState: 'open_fresh' | 'open_stale' | 'resolved_recovered' | 'resolved_lost'
  finalStatus: string | null
}

/**
 * Block 4 — Smart-ranked auto-lost audit.
 *
 * Ranks `subscriber_auto_lost` events by miss-likelihood
 * (`interest_score` = MRR + reply count + portal-click + addressable
 * category − dead-text patterns). Top N (default 15). Same dataset
 * as the legacy `autoLostAudit`, just sorted by worth-investigating-ness
 * instead of recency, with the ranking computed at the DB level so
 * LIMIT is honoured at the query layer.
 *
 * The dead-text regex is intentionally narrow — only matches
 * unambiguous "definitely not coming back" signals so we don't
 * accidentally demote recoverable cases.
 */
export async function rankedAutoLostAudit(limit = 15): Promise<RankedAuditRow[]> {
  const db = getDbReadOnly()
  const result = await db.execute(sql`
    SELECT
      s.id                        AS subscriber_id,
      s.customer_id               AS customer_id,
      s.name                      AS name,
      s.email                     AS email,
      c.product_name              AS product_name,
      u.email                     AS customer_email,
      s.mrr_cents                 AS mrr_cents,
      s.tenure_days               AS tenure_days,
      s.cancellation_reason       AS cancellation_reason,
      s.cancellation_category     AS cancellation_category,
      s.recovery_likelihood       AS recovery_likelihood,
      s.handoff_reasoning         AS handoff_reasoning,
      (s.billing_portal_clicked_at IS NOT NULL) AS billing_portal_clicked,
      coalesce(rc.reply_count, 0) AS reply_count,
      e.created_at                AS occurred_at,
      (
        (CASE WHEN s.mrr_cents > 5000 THEN 3 ELSE 0 END) +
        (CASE WHEN coalesce(rc.reply_count, 0) >= 2 THEN 2 ELSE 0 END) +
        (CASE WHEN s.billing_portal_clicked_at IS NOT NULL THEN 2 ELSE 0 END) +
        (CASE WHEN s.cancellation_category IN ('Feature', 'Quality') THEN 2 ELSE 0 END) +
        (CASE WHEN s.tenure_days > 90 THEN 1 ELSE 0 END) -
        (CASE WHEN
          lower(coalesce(s.stripe_comment, '') || ' ' || coalesce(s.cancellation_reason, ''))
            ~ '(going out of business|deceased|switching jobs|company shut down|no longer in business|closing down)'
          THEN 2 ELSE 0 END)
      ) AS interest_score
    FROM wb_events e
    JOIN wb_churned_subscribers s ON s.id = (e.properties->>'subscriberId')::uuid
    LEFT JOIN wb_customers c ON c.id = s.customer_id
    LEFT JOIN wb_users u     ON u.id = c.user_id
    LEFT JOIN (
      SELECT subscriber_id, count(*)::int AS reply_count
      FROM wb_subscriber_replies
      GROUP BY subscriber_id
    ) rc ON rc.subscriber_id = s.id
    WHERE e.name = 'subscriber_auto_lost'
    ORDER BY interest_score DESC, s.mrr_cents DESC, e.created_at DESC
    LIMIT ${limit}
  `)
  return ((result.rows ?? []) as Array<Record<string, unknown>>).map(coerceRankedRow)
}

/**
 * Block 5 — Smart-ranked handoff audit (with founder-resolution column).
 *
 * Same ranking heuristic as Block 4. Adds a derived `resolutionState`:
 *   - open_fresh        — handed off < 7 days ago, not resolved
 *   - open_stale        — handed off >= 7 days ago, not resolved
 *   - resolved_recovered — resolved AND status='recovered'
 *   - resolved_lost     — resolved AND status not 'recovered' (lost / unsubscribed)
 *
 * Stale opens (>=7d) are the actionable signal: either founder
 * backlog or the AI escalated a case that didn't warrant it.
 */
export async function rankedHandoffAudit(limit = 15): Promise<RankedHandoffRow[]> {
  const db = getDbReadOnly()
  const result = await db.execute(sql`
    SELECT
      s.id                          AS subscriber_id,
      s.customer_id                 AS customer_id,
      s.name                        AS name,
      s.email                       AS email,
      c.product_name                AS product_name,
      u.email                       AS customer_email,
      s.mrr_cents                   AS mrr_cents,
      s.tenure_days                 AS tenure_days,
      s.cancellation_reason         AS cancellation_reason,
      s.cancellation_category       AS cancellation_category,
      s.recovery_likelihood         AS recovery_likelihood,
      s.handoff_reasoning           AS handoff_reasoning,
      (s.billing_portal_clicked_at IS NOT NULL) AS billing_portal_clicked,
      coalesce(rc.reply_count, 0)   AS reply_count,
      s.founder_handoff_at          AS occurred_at,
      s.founder_handoff_at          AS founder_handoff_at,
      s.founder_handoff_resolved_at AS founder_handoff_resolved_at,
      s.status                      AS final_status,
      (
        (CASE WHEN s.mrr_cents > 5000 THEN 3 ELSE 0 END) +
        (CASE WHEN coalesce(rc.reply_count, 0) >= 2 THEN 2 ELSE 0 END) +
        (CASE WHEN s.billing_portal_clicked_at IS NOT NULL THEN 2 ELSE 0 END) +
        (CASE WHEN s.cancellation_category IN ('Feature', 'Quality') THEN 2 ELSE 0 END) +
        (CASE WHEN s.tenure_days > 90 THEN 1 ELSE 0 END) -
        (CASE WHEN
          lower(coalesce(s.stripe_comment, '') || ' ' || coalesce(s.cancellation_reason, ''))
            ~ '(going out of business|deceased|switching jobs|company shut down|no longer in business|closing down)'
          THEN 2 ELSE 0 END)
      ) AS interest_score
    FROM wb_churned_subscribers s
    LEFT JOIN wb_customers c ON c.id = s.customer_id
    LEFT JOIN wb_users u     ON u.id = c.user_id
    LEFT JOIN (
      SELECT subscriber_id, count(*)::int AS reply_count
      FROM wb_subscriber_replies
      GROUP BY subscriber_id
    ) rc ON rc.subscriber_id = s.id
    WHERE s.founder_handoff_at IS NOT NULL
    ORDER BY interest_score DESC, s.mrr_cents DESC, s.founder_handoff_at DESC
    LIMIT ${limit}
  `)
  return ((result.rows ?? []) as Array<Record<string, unknown>>).map((r): RankedHandoffRow => {
    const base = coerceRankedRow(r)
    const handoffAt  = r.founder_handoff_at          ? new Date(String(r.founder_handoff_at))          : null
    const resolvedAt = r.founder_handoff_resolved_at ? new Date(String(r.founder_handoff_resolved_at)) : null
    const finalStatus = r.final_status === null ? null : String(r.final_status ?? '')
    let resolutionState: RankedHandoffRow['resolutionState']
    if (resolvedAt) {
      resolutionState = finalStatus === 'recovered' ? 'resolved_recovered' : 'resolved_lost'
    } else {
      const ageMs = handoffAt ? Date.now() - handoffAt.getTime() : 0
      const STALE_MS = 7 * 24 * 60 * 60 * 1000
      resolutionState = ageMs >= STALE_MS ? 'open_stale' : 'open_fresh'
    }
    return {
      ...base,
      founderHandoffAt: handoffAt,
      founderHandoffResolvedAt: resolvedAt,
      resolutionState,
      finalStatus,
    }
  })
}

export interface HandoffAuditSummary {
  windowDays: number
  total: number
  resolved: number
  recovered: number
  open: number
  stale: number
  recoveryPct: number   // recovered / resolved (resolved=0 → 0)
}

/**
 * Aggregate footer for Block 5 — last `windowDays` handoff stats:
 * total, resolved, recovered, open, stale (>=7d unresolved).
 */
export async function handoffAuditSummary(windowDays = 30): Promise<HandoffAuditSummary> {
  const db = getDbReadOnly()
  const result = await db.execute(sql`
    SELECT
      count(*)::int                                                                   AS total,
      count(*) FILTER (WHERE s.founder_handoff_resolved_at IS NOT NULL)::int          AS resolved,
      count(*) FILTER (WHERE s.founder_handoff_resolved_at IS NOT NULL
                        AND s.status = 'recovered')::int                              AS recovered,
      count(*) FILTER (WHERE s.founder_handoff_resolved_at IS NULL)::int              AS open,
      count(*) FILTER (WHERE s.founder_handoff_resolved_at IS NULL
                        AND s.founder_handoff_at < now() - interval '7 days')::int    AS stale
    FROM wb_churned_subscribers s
    WHERE s.founder_handoff_at >= now() - (${windowDays}::int * interval '1 day')
  `)
  const r = (result.rows?.[0] ?? {}) as Record<string, unknown>
  const total     = Number(r.total     ?? 0)
  const resolved  = Number(r.resolved  ?? 0)
  const recovered = Number(r.recovered ?? 0)
  const open      = Number(r.open      ?? 0)
  const stale     = Number(r.stale     ?? 0)
  const recoveryPct = resolved > 0 ? (recovered / resolved) * 100 : 0
  return { windowDays, total, resolved, recovered, open, stale, recoveryPct }
}

function coerceRankedRow(r: Record<string, unknown>): RankedAuditRow {
  return {
    subscriberId:         String(r.subscriber_id),
    customerId:           r.customer_id === null ? null : String(r.customer_id ?? ''),
    name:                 r.name        === null ? null : String(r.name ?? ''),
    email:                r.email       === null ? null : String(r.email ?? ''),
    productName:          r.product_name === null ? null : String(r.product_name ?? ''),
    customerEmail:        r.customer_email === null ? null : String(r.customer_email ?? ''),
    mrrCents:             Number(r.mrr_cents ?? 0),
    tenureDays:           r.tenure_days === null ? null : Number(r.tenure_days ?? 0),
    cancellationReason:   r.cancellation_reason === null ? null : String(r.cancellation_reason ?? ''),
    cancellationCategory: r.cancellation_category === null ? null : String(r.cancellation_category ?? ''),
    recoveryLikelihood:   (r.recovery_likelihood as RankedAuditRow['recoveryLikelihood']) ?? null,
    handoffReasoning:     r.handoff_reasoning === null ? null : String(r.handoff_reasoning ?? ''),
    replyCount:           Number(r.reply_count ?? 0),
    billingPortalClicked: Boolean(r.billing_portal_clicked),
    interestScore:        Number(r.interest_score ?? 0),
    occurredAt:           r.occurred_at ? new Date(String(r.occurred_at)) : null,
  }
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

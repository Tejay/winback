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

import { sql, and, eq, isNotNull, desc } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { churnedSubscribers, customers, users } from '../schema'

const DAY_MS = 24 * 60 * 60 * 1000

function nDaysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS)
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
  const conf7d    = numOr(subAgg.conf_med_7d, 0)
  const conf23d   = numOr(subAgg.conf_med_23d, 0)
  // Handoff and auto-lost metrics were removed: the classifier no longer
  // emits founder handoffs or subscriber_auto_lost events (classifier.ts:
  // "there is no automatic handoff anymore"). Tier-4 is now the AI's only
  // suppression decision — relabelled below.

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
  const lowShare7d = pctShare(low7d, class7d)
  const lowShare23d = pctShare(low23d, class23d)

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
      // The AI's only suppression decision now: tier 4 = don't email.
      // A rising share means the AI is silencing more subscribers —
      // fewer recovery attempts.
      label: 'Suppressed share (tier 4 — not emailed)',
      last7d: tier4Share7d,
      prior23d: tier4Share23d,
      deltaPct: pctDelta(tier4Share7d, tier4Share23d),
      flagged: flag(pctDelta(tier4Share7d, tier4Share23d), 'up'),
      format: 'percent',
    },
    {
      label: 'Low recovery-likelihood share',
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
  /** recovered / n × 100 — the calibration figure. Should be monotonic: high > medium > low. */
  recoveryRatePct: number
}

/**
 * Suppression reversal — the AI's modern false-negative measure. Of the
 * subscribers the AI chose NOT to email (tier 4 / status='skipped') in the
 * settled cohort, how many recovered anyway? A non-trivial rate means the
 * AI is silencing recoverable subscribers (replaces the dead auto-lost
 * reversal — there are no auto-lost events anymore).
 */
export interface SuppressionReversal {
  suppressed: number
  recovered: number
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
  /** Recovery rate per predicted-likelihood bucket — the calibration test. */
  byLikelihood: LikelihoodCalibrationRow[]
  /** Did the AI wrongly suppress recoverable subscribers? */
  suppressionReversal: SuppressionReversal
}

/**
 * Block 1 — Outcome-grounded calibration.
 *
 * The "settled cohort" is subscribers classified ≥30 days ago and ≤90
 * days ago — long enough for outcomes to settle, recent enough to reflect
 * the current prompt.
 *
 * Two derived figures:
 *   - recovery rate by predicted likelihood (the calibration test —
 *     should be monotonic: high > medium > low; if not, the AI's
 *     confidence is noise)
 *   - suppression reversal (of subscribers the AI chose NOT to email,
 *     tier 4, how many recovered anyway? = the modern false-negative)
 */
export async function calibrationCohort(
  cohortStartDaysAgo = 90,
  cohortEndDaysAgo   = 30,
): Promise<CalibrationCohort> {
  const db = getDbReadOnly()

  const startDate = nDaysAgo(cohortStartDaysAgo)
  const endDate   = nDaysAgo(cohortEndDaysAgo)

  // Recovery rate per predicted likelihood bucket.
  const calibrationResult = await db.execute(sql`
    SELECT
      s.recovery_likelihood AS likelihood,
      count(*)::int AS n,
      count(*) FILTER (WHERE s.status = 'recovered')::int AS recovered
    FROM wb_churned_subscribers s
    WHERE s.classified_at >= now() - (${cohortStartDaysAgo}::int * interval '1 day')
      AND s.classified_at <  now() - (${cohortEndDaysAgo}::int * interval '1 day')
      AND s.recovery_likelihood IS NOT NULL
    GROUP BY s.recovery_likelihood
  `)
  const calRows = (calibrationResult.rows ?? []) as Array<Record<string, unknown>>
  const byLikelihood: LikelihoodCalibrationRow[] = (['high', 'medium', 'low'] as const).map((lh) => {
    const r = calRows.find((row) => row.likelihood === lh)
    const n = Number(r?.n ?? 0)
    const recovered = Number(r?.recovered ?? 0)
    return {
      likelihood: lh,
      n,
      recovered,
      recoveryRatePct: n > 0 ? Math.round((recovered / n) * 1000) / 10 : 0,
    }
  })

  // Suppression reversal: tier-4 (status='skipped') subscribers in the
  // cohort that recovered anyway — the AI's modern false negatives.
  const reversalResult = await db.execute(sql`
    SELECT
      count(*)::int AS suppressed,
      count(*) FILTER (WHERE s.status = 'recovered')::int AS recovered
    FROM wb_churned_subscribers s
    WHERE s.classified_at >= now() - (${cohortStartDaysAgo}::int * interval '1 day')
      AND s.classified_at <  now() - (${cohortEndDaysAgo}::int * interval '1 day')
      AND s.tier = 4
  `)
  const revRow = (reversalResult.rows?.[0] ?? {}) as Record<string, unknown>
  const suppressed = Number(revRow.suppressed ?? 0)
  const recovered  = Number(revRow.recovered ?? 0)

  let reversedSample: SuppressionReversal['reversedSample'] = []
  if (recovered > 0) {
    const sampleResult = await db.execute(sql`
      SELECT s.id AS subscriber_id, s.name, s.email, s.updated_at AS recovered_at
      FROM wb_churned_subscribers s
      WHERE s.classified_at >= now() - (${cohortStartDaysAgo}::int * interval '1 day')
        AND s.classified_at <  now() - (${cohortEndDaysAgo}::int * interval '1 day')
        AND s.tier = 4
        AND s.status = 'recovered'
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
    suppressionReversal: { suppressed, recovered, reversedSample },
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

/**
 * Block 4 — Smart-ranked SUPPRESSION audit.
 *
 * The AI's only "don't bother" decision now is tier 4 = suppress (no
 * email, status='skipped'). This ranks the suppressed subscribers by
 * miss-likelihood (`interest_score` = MRR + reply count + portal-click +
 * addressable category − dead-text patterns) so a human can spot-check
 * the highest-value cases the AI chose to silence. Replaces the dead
 * auto-lost audit (no auto-lost events are emitted anymore).
 */
export async function rankedSuppressionAudit(limit = 15): Promise<RankedAuditRow[]> {
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
      s.classified_at             AS occurred_at,
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
    WHERE s.tier = 4 AND s.classified_at IS NOT NULL
    ORDER BY interest_score DESC, s.mrr_cents DESC, s.classified_at DESC
    LIMIT ${limit}
  `)
  return ((result.rows ?? []) as Array<Record<string, unknown>>).map(coerceRankedRow)
}

/**
 * Block 5 (new) — Email performance.
 *
 * The classifier writes the actual email copy now (firstMessage +
 * winBackBody), so the emails ARE an AI output. Reply rate by type is the
 * most direct quality signal — people replying means the copy landed.
 * (Recovery $ lives on the Insights page.) Plus the flagged-for-review
 * queue from the inspector's "🚩 flag" action.
 */
export interface EmailPerformanceRow {
  type: string
  sent: number
  replied: number
  replyRatePct: number
}
export interface FlaggedEmail {
  emailId: string
  subject: string | null
  type: string | null
  note: string | null
  subscriberId: string | null
  flaggedAt: Date
}
export interface EmailPerformance {
  windowDays: number
  byType: EmailPerformanceRow[]
  flaggedCount: number
  recentFlagged: FlaggedEmail[]
}

export async function emailPerformance(windowDays = 30): Promise<EmailPerformance> {
  const db = getDbReadOnly()

  const perfResult = await db.execute(sql`
    SELECT
      type,
      count(*)::int AS sent,
      count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
    FROM wb_emails_sent
    WHERE sent_at >= now() - (${windowDays}::int * interval '1 day')
    GROUP BY type
    ORDER BY sent DESC
  `)
  const byType: EmailPerformanceRow[] = ((perfResult.rows ?? []) as Array<Record<string, unknown>>).map((r) => {
    const sent = Number(r.sent ?? 0)
    const replied = Number(r.replied ?? 0)
    return {
      type: String(r.type ?? 'unknown'),
      sent,
      replied,
      replyRatePct: sent > 0 ? Math.round((replied / sent) * 1000) / 10 : 0,
    }
  })

  // Flagged emails — wb_events name='email_flagged' (from the inspector).
  const flaggedResult = await db.execute(sql`
    SELECT
      properties->>'emailId'      AS email_id,
      properties->>'subject'      AS subject,
      properties->>'type'         AS type,
      properties->>'note'         AS note,
      properties->>'subscriberId' AS subscriber_id,
      created_at                  AS flagged_at
    FROM wb_events
    WHERE name = 'email_flagged'
    ORDER BY created_at DESC
    LIMIT 15
  `)
  const recentFlagged: FlaggedEmail[] = ((flaggedResult.rows ?? []) as Array<Record<string, unknown>>).map((r) => ({
    emailId:      String(r.email_id ?? ''),
    subject:      r.subject === null ? null : String(r.subject ?? ''),
    type:         r.type === null ? null : String(r.type ?? ''),
    note:         r.note === null ? null : String(r.note ?? ''),
    subscriberId: r.subscriber_id === null ? null : String(r.subscriber_id ?? ''),
    flaggedAt:    new Date(String(r.flagged_at)),
  }))

  const countResult = await db.execute(sql`
    SELECT count(*)::int AS n FROM wb_events WHERE name = 'email_flagged'
  `)
  const flaggedCount = Number((countResult.rows?.[0] as Record<string, unknown> | undefined)?.n ?? 0)

  return { windowDays, byType, flaggedCount, recentFlagged }
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


/**
 * Spec 26 — Aggregation queries for /admin/ai-quality.
 *
 * Five blocks: handoff trend, recovery-likelihood histogram, tier
 * distribution, hand-off reasoning audit, silent-close audit. All
 * read-only; all hit existing indexes.
 */

import { sql, and, eq, gte, isNotNull, desc } from 'drizzle-orm'
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

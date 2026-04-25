/**
 * Spec 25 — Aggregation queries for /admin (overview page).
 *
 * All queries use the read-only DB connection and hit existing
 * (name, created_at) / (customer_id, created_at) indexes on wb_events.
 * Each rollup returns a small fixed-shape object so the dashboard can
 * render without further client-side reshaping.
 */

import { sql, and, eq, gte } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { wbEvents, customers, churnedSubscribers } from '../schema'

const DAY_MS = 24 * 60 * 60 * 1000

function startOfTodayUtc(): Date {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

function nDaysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS)
}

/**
 * Count events of a given name since the given start time. The basic atom
 * for every today/sparkline figure on the overview page.
 */
async function countEventsSince(name: string, since: Date): Promise<number> {
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, name), gte(wbEvents.createdAt, since)))
  return row?.n ?? 0
}

/**
 * Daily counts for an event name, oldest → newest, padded so the array always
 * has `days` entries (zeros for days with no events). Powers the sparklines.
 */
async function dailyBucketsForEvent(name: string, days: number): Promise<number[]> {
  const since = nDaysAgo(days - 1)  // include today
  since.setUTCHours(0, 0, 0, 0)
  const rows = await getDbReadOnly()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${wbEvents.createdAt}), 'YYYY-MM-DD')`,
      n: sql<number>`count(*)::int`,
    })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, name), gte(wbEvents.createdAt, since)))
    .groupBy(sql`date_trunc('day', ${wbEvents.createdAt})`)

  // Build a date-keyed lookup, then walk `days` days forward from `since`.
  const byDay = new Map(rows.map((r) => [r.day, r.n]))
  const buckets: number[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * DAY_MS)
    const key = d.toISOString().slice(0, 10)
    buckets.push(byDay.get(key) ?? 0)
  }
  return buckets
}

export interface OverviewRollup {
  today: {
    classifications: number
    emailsSent: number
    replies: number
    recoveries: { strong: number; weak: number; organic: number; total: number }
    errors: number
  }
  sparklines: {
    emailsSent: number[]
    replies: number[]
    recoveries: number[]
    errors: number[]
  }
  totals: {
    activeCustomers: number
    paidCustomers: number
    trialCustomers: number
    subscribersEver: number
  }
  redLights: Array<{ metric: string; today: number; median7d: number }>
}

/**
 * Recoveries today, split by attribution type. Reads the JSONB
 * properties.attributionType field, which is set in processCheckoutRecovery
 * and the test-harness simulate-recovery action.
 */
async function recoveriesTodaySplit(): Promise<{ strong: number; weak: number; organic: number; total: number }> {
  const since = startOfTodayUtc()
  const rows = await getDbReadOnly()
    .select({
      type: sql<string>`coalesce(${wbEvents.properties}->>'attributionType', 'organic')`,
      n: sql<number>`count(*)::int`,
    })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, 'subscriber_recovered'), gte(wbEvents.createdAt, since)))
    .groupBy(sql`coalesce(${wbEvents.properties}->>'attributionType', 'organic')`)

  const out = { strong: 0, weak: 0, organic: 0, total: 0 }
  for (const r of rows) {
    if (r.type === 'strong') out.strong = r.n
    else if (r.type === 'weak') out.weak = r.n
    else out.organic = r.n
    out.total += r.n
  }
  return out
}

/**
 * Errors today — sum of two known error event names. Cheap query — both
 * names hit the (name, created_at) index independently.
 */
async function errorsTodaySum(): Promise<number> {
  const since = startOfTodayUtc()
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(wbEvents)
    .where(
      and(
        sql`${wbEvents.name} in ('oauth_error', 'billing_invoice_failed', 'reactivate_failed')`,
        gte(wbEvents.createdAt, since),
      ),
    )
  return row?.n ?? 0
}

/**
 * Daily error count buckets — same shape as dailyBucketsForEvent but covers
 * the union of error-class event names.
 */
async function errorBuckets(days: number): Promise<number[]> {
  const since = nDaysAgo(days - 1)
  since.setUTCHours(0, 0, 0, 0)
  const rows = await getDbReadOnly()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${wbEvents.createdAt}), 'YYYY-MM-DD')`,
      n: sql<number>`count(*)::int`,
    })
    .from(wbEvents)
    .where(
      and(
        sql`${wbEvents.name} in ('oauth_error', 'billing_invoice_failed', 'reactivate_failed')`,
        gte(wbEvents.createdAt, since),
      ),
    )
    .groupBy(sql`date_trunc('day', ${wbEvents.createdAt})`)

  const byDay = new Map(rows.map((r) => [r.day, r.n]))
  const buckets: number[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * DAY_MS)
    buckets.push(byDay.get(d.toISOString().slice(0, 10)) ?? 0)
  }
  return buckets
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * Build the full overview rollup in parallel. ~6 small queries, all hit
 * indexes; should respond in well under 200ms even at 100k events/day.
 */
export async function buildOverviewRollup(): Promise<OverviewRollup> {
  const todayStart = startOfTodayUtc()

  const [
    emailsSentToday,
    repliesToday,
    recoveriesToday,
    errorsToday,
    emailsSpark,
    repliesSpark,
    recoveriesSpark,
    errorsSpark,
    customerCounts,
    subscribersEverRow,
  ] = await Promise.all([
    countEventsSince('email_sent', todayStart),
    countEventsSince('email_replied', todayStart),
    recoveriesTodaySplit(),
    errorsTodaySum(),
    dailyBucketsForEvent('email_sent', 7),
    dailyBucketsForEvent('email_replied', 7),
    dailyBucketsForEvent('subscriber_recovered', 7),
    errorBuckets(7),
    getDbReadOnly()
      .select({
        active: sql<number>`count(*) filter (where ${customers.stripeAccessToken} is not null)::int`,
        paid:   sql<number>`count(*) filter (where ${customers.plan} = 'paid')::int`,
        trial:  sql<number>`count(*) filter (where ${customers.plan} = 'trial' or ${customers.plan} is null)::int`,
      })
      .from(customers),
    getDbReadOnly()
      .select({ n: sql<number>`count(*)::int` })
      .from(churnedSubscribers),
  ])

  // Red lights: any metric where today > 3 × median(last 7 days, excluding today).
  const redLights: OverviewRollup['redLights'] = []
  const checks: Array<{ metric: string; today: number; spark: number[] }> = [
    { metric: 'errors', today: errorsToday, spark: errorsSpark },
    { metric: 'replies', today: repliesToday, spark: repliesSpark },
  ]
  for (const c of checks) {
    const past = c.spark.slice(0, -1)  // exclude today's bucket
    const m = median(past)
    if (m > 0 && c.today > 3 * m) {
      redLights.push({ metric: c.metric, today: c.today, median7d: m })
    } else if (m === 0 && c.today > 5) {
      // Bootstrap case — no history yet, but a sudden spike is still worth flagging.
      redLights.push({ metric: c.metric, today: c.today, median7d: 0 })
    }
  }

  const cc = customerCounts[0] ?? { active: 0, paid: 0, trial: 0 }

  return {
    today: {
      classifications: emailsSentToday,  // proxy — every send corresponds to one classification
      emailsSent: emailsSentToday,
      replies: repliesToday,
      recoveries: recoveriesToday,
      errors: errorsToday,
    },
    sparklines: {
      emailsSent: emailsSpark,
      replies: repliesSpark,
      recoveries: recoveriesSpark,
      errors: errorsSpark,
    },
    totals: {
      activeCustomers: cc.active,
      paidCustomers: cc.paid,
      trialCustomers: cc.trial,
      subscribersEver: subscribersEverRow[0]?.n ?? 0,
    },
    redLights,
  }
}

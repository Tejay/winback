/**
 * Spec 25 — Aggregation queries for /admin (overview page).
 *
 * All queries use the read-only DB connection and hit existing
 * (name, created_at) / (customer_id, created_at) indexes on wb_events.
 * Each rollup returns a small fixed-shape object so the dashboard can
 * render without further client-side reshaping.
 */

import { sql, and, eq, gte, inArray } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { wbEvents, recoveries, users } from '../schema'

/**
 * Spec 26 — full set of error-class event names. Matches the entries logged
 * from the four new observability paths (email_send_failed, classifier_failed,
 * webhook_signature_invalid) plus the original three. Exported so the per-
 * source breakdown stays consistent with the events page filter.
 */
export const ERROR_EVENT_NAMES = [
  'oauth_error',
  'billing_invoice_failed',
  'reactivate_failed',
  'email_send_failed',
  'classifier_failed',
  'webhook_signature_invalid',
] as const

export type ErrorSource = typeof ERROR_EVENT_NAMES[number]

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
    /** Spec 26 — replaces `replies` (weak signal once volume's up). */
    handoffs: number
    recoveries: { strong: number; weak: number; organic: number; total: number }
    /** Spec 26 — strong (billable) MRR recovered today, in cents. */
    mrrCents: number
    errors: {
      total: number
      /** Per-source breakdown for triage. Keys correspond to ERROR_EVENT_NAMES. */
      bySource: Record<ErrorSource, number>
    }
  }
  sparklines: {
    emailsSent: number[]
    handoffs: number[]
    recoveries: number[]
    /** Spec 26 — strong MRR (cents) per day, last 7 days. */
    mrrCents: number[]
    errors: number[]
  }
  /**
   * Spec 26.5 — actionable growth + health signals (replaces the old static
   * "platform totals" row, which was point-in-time decoration). Each has
   * today's value plus the 7-day total so trends are visible at a glance.
   */
  growth: {
    signupsToday: number
    signups7d: number
    conversionsToday: number
    conversions7d: number
    customersActive24h: number
    customersActive7d: number
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
 * Spec 26 — Errors today, split by source. Each source = one of the known
 * error event names. The per-source breakdown drives the triage UI on
 * /admin (one click filters /admin/events by that source).
 */
async function errorsTodayBySource(): Promise<{ total: number; bySource: Record<ErrorSource, number> }> {
  const since = startOfTodayUtc()
  const rows = await getDbReadOnly()
    .select({
      name: wbEvents.name,
      n: sql<number>`count(*)::int`,
    })
    .from(wbEvents)
    .where(
      and(
        // inArray generates a single $N::text[] placeholder — correct ANY() usage.
        // `sql\`... = ANY(${array})\`` would expand each item to its own $N
        // and produce invalid `ANY($1, $2, ...)` syntax.
        inArray(wbEvents.name, ERROR_EVENT_NAMES as unknown as string[]),
        gte(wbEvents.createdAt, since),
      ),
    )
    .groupBy(wbEvents.name)

  const bySource = Object.fromEntries(
    ERROR_EVENT_NAMES.map((n) => [n, 0]),
  ) as Record<ErrorSource, number>
  let total = 0
  for (const r of rows) {
    if ((ERROR_EVENT_NAMES as readonly string[]).includes(r.name)) {
      bySource[r.name as ErrorSource] = r.n
      total += r.n
    }
  }
  return { total, bySource }
}

/**
 * Daily error count buckets — covers the union of all error-class event names
 * for sparkline rendering on the overview tile.
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
        inArray(wbEvents.name, ERROR_EVENT_NAMES as unknown as string[]),
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

/**
 * Spec 26 — strong (billable) MRR recovered today, in cents.
 * Sources from wb_recoveries directly, not wb_events, because the events
 * row only stores the per-recovery cents and we want the sum.
 */
async function mrrCentsToday(): Promise<number> {
  const since = startOfTodayUtc()
  const [row] = await getDbReadOnly()
    .select({ cents: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::bigint` })
    .from(recoveries)
    .where(
      and(
        gte(recoveries.recoveredAt, since),
        eq(recoveries.attributionType, 'strong'),
      ),
    )
  // bigint comes back as string in some drivers; coerce defensively.
  return Number(row?.cents ?? 0)
}

/**
 * Spec 26 — strong-MRR daily buckets for the last `days` days. Same padding
 * scheme as dailyBucketsForEvent.
 */
async function mrrCentsBuckets(days: number): Promise<number[]> {
  const since = nDaysAgo(days - 1)
  since.setUTCHours(0, 0, 0, 0)
  const rows = await getDbReadOnly()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${recoveries.recoveredAt}), 'YYYY-MM-DD')`,
      cents: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::bigint`,
    })
    .from(recoveries)
    .where(
      and(
        gte(recoveries.recoveredAt, since),
        eq(recoveries.attributionType, 'strong'),
      ),
    )
    .groupBy(sql`date_trunc('day', ${recoveries.recoveredAt})`)

  const byDay = new Map(rows.map((r) => [r.day, Number(r.cents)]))
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
 * Spec 26.5 — Growth + health queries. Each returns one integer.
 * Cheap: signups hits wb_users.created_at (small table); conversions and
 * active hit (name, created_at) and (customer_id, created_at) indexes.
 */
async function signupsSince(since: Date): Promise<number> {
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(gte(users.createdAt, since))
  return row?.n ?? 0
}

async function trialToPaidSince(since: Date): Promise<number> {
  // billing_card_captured fires when a founder completes the platform card
  // capture flow — the moment trial → paid happens on our side.
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, 'billing_card_captured'), gte(wbEvents.createdAt, since)))
  return row?.n ?? 0
}

async function customersActiveSince(since: Date): Promise<number> {
  // Distinct customer_ids that have produced any event in the window.
  // Better proxy for "actually integrated and producing data" than just
  // "has a stripe access token".
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(distinct ${wbEvents.customerId})::int` })
    .from(wbEvents)
    .where(and(
      gte(wbEvents.createdAt, since),
      sql`${wbEvents.customerId} is not null`,
    ))
  return row?.n ?? 0
}

/**
 * Build the full overview rollup in parallel. All queries hit indexes;
 * should respond in well under 300ms even at 100k events/day.
 */
export async function buildOverviewRollup(): Promise<OverviewRollup> {
  const todayStart = startOfTodayUtc()
  const sevenDaysAgo = nDaysAgo(7)
  const oneDayAgo = new Date(Date.now() - DAY_MS)

  const [
    emailsSentToday,
    handoffsToday,
    recoveriesToday,
    errorsToday,
    mrrToday,
    emailsSpark,
    handoffsSpark,
    recoveriesSpark,
    mrrSpark,
    errorsSpark,
    // Spec 26.5 — growth + health (replaces the old static totals row).
    signupsToday,
    signups7d,
    conversionsToday,
    conversions7d,
    customersActive24h,
    customersActive7d,
  ] = await Promise.all([
    countEventsSince('email_sent', todayStart),
    // Spec 26 — replaces replies (which was a weak signal). Handoffs map
    // directly to the AI-quality question and are more actionable.
    countEventsSince('founder_handoff_triggered', todayStart),
    recoveriesTodaySplit(),
    errorsTodayBySource(),
    mrrCentsToday(),
    dailyBucketsForEvent('email_sent', 7),
    dailyBucketsForEvent('founder_handoff_triggered', 7),
    dailyBucketsForEvent('subscriber_recovered', 7),
    mrrCentsBuckets(7),
    errorBuckets(7),
    signupsSince(todayStart),
    signupsSince(sevenDaysAgo),
    trialToPaidSince(todayStart),
    trialToPaidSince(sevenDaysAgo),
    customersActiveSince(oneDayAgo),
    customersActiveSince(sevenDaysAgo),
  ])

  // Red lights: any metric where today > 3 × median(last 7 days, excluding today).
  const redLights: OverviewRollup['redLights'] = []
  const checks: Array<{ metric: string; today: number; spark: number[] }> = [
    { metric: 'errors', today: errorsToday.total, spark: errorsSpark },
    // Replies → handoffs swap also flows through to red-light detection.
    // A sudden handoff spike is the most useful early-warning of prompt regression.
    { metric: 'handoffs', today: handoffsToday, spark: handoffsSpark },
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

  return {
    today: {
      classifications: emailsSentToday,  // proxy — every send corresponds to one classification
      emailsSent: emailsSentToday,
      handoffs: handoffsToday,
      recoveries: recoveriesToday,
      mrrCents: mrrToday,
      errors: errorsToday,
    },
    sparklines: {
      emailsSent: emailsSpark,
      handoffs: handoffsSpark,
      recoveries: recoveriesSpark,
      mrrCents: mrrSpark,
      errors: errorsSpark,
    },
    growth: {
      signupsToday,
      signups7d,
      conversionsToday,
      conversions7d,
      customersActive24h,
      customersActive7d,
    },
    redLights,
  }
}

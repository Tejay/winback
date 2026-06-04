/**
 * Spec 25 — Aggregation queries for /admin (overview page).
 *
 * All queries use the read-only DB connection and hit existing
 * (name, created_at) / (customer_id, created_at) indexes on wb_events.
 * Each rollup returns a small fixed-shape object so the dashboard can
 * render without further client-side reshaping.
 */

import { sql, and, eq, gte, inArray, isNotNull, isNull, or } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { wbEvents, recoveries, users, customers } from '../schema'

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
    /** Strong-attribution MRR recovered today, in cents. NOTE: post
     *  billing-rewrite there is no per-recovery fee — this is a
     *  value-delivered health signal, NOT platform revenue. (Was
     *  labelled "billable" in the perf-fee era; relabelled 2026-05-29.) */
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
    /** Strong-attribution MRR (cents) per day, last 7 days. */
    mrrCents: number[]
    errors: number[]
  }
  /**
   * 2026-05-29 — the first-save paywall cohort. After the pause-at-first
   * -save gate (PR #169), merchants who've had a recovery delivered but
   * haven't subscribed are parked in a paused state. This surfaces how
   * many are stuck there and how much gate activity is happening, so the
   * gate's conversion impact is visible instead of silent.
   */
  paywall: {
    /** Point-in-time: customers past the gate (activated, no sub, not on
     *  an active pilot). The "stuck at the paywall right now" number. */
    stuckAtPaywall: number
    /** Today's count of classifier/send skips caused by the gate. Rising
     *  = more work being suppressed for unpaid-but-activated merchants. */
    gateSkipsToday: number
    /** Today's count of un-pause attempts blocked for lack of a sub —
     *  direct demand signal for the gated service. */
    unpauseBlockedToday: number
  }
  /**
   * 2026-05-29 — platform revenue health. Replaces what the gutted
   * /admin/billing page no longer shows after the perf-fee removal:
   * tier mix + subscription churn are the business metrics now.
   */
  billing: {
    /** Customers with a live platform sub, grouped by billed tier. */
    tierDistribution: { starter: number; growth: number; scale: number; enterprise: number; custom: number }
    /** Customers flagged requires_sales (Enterprise hand-off backlog). */
    requiresSales: number
    /** Platform-sub cancellations in the last 7 days (churn). */
    subsCanceled7d: number
    /** Platform-sub reactivations in the last 7 days. */
    reactivations7d: number
    /** Platform invoice failures today (renewal/dunning health). */
    invoiceFailedToday: number
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
  /**
   * Red-light signals. `kind` distinguishes:
   *  - 'spike' = today > 3× 7d median (existing behaviour)
   *  - 'floor' = today < 30% of 7d median after noon UTC (new — catches
   *    silent-zero outages like a dead send pipeline)
   * `concentration` is set on the 'errors' rule when one customer
   * accounts for >50% of today's errors — distinguishes "1 noisy
   * customer" from "systemic regression" in one glance.
   */
  redLights: Array<{
    metric: string
    kind: 'spike' | 'floor'
    today: number
    median7d: number
    summary: string
    concentration?: { customerId: string; customerEmail: string | null; n: number }
  }>
  /** Latest 5 error events with truncated message — recent-failures tail under the Errors panel. */
  errorsTail: Array<{
    id: string
    name: string
    customerId: string | null
    customerEmail: string | null
    snippet: string
    createdAt: string
  }>
  /** Latest 5 admin actions — "recent admin activity" widget on Now. */
  recentAdminActivity: Array<{
    id: string
    action: string
    adminEmail: string | null
    customerId: string | null
    customerEmail: string | null
    createdAt: string
  }>
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
 * Strong-attribution MRR recovered today, in cents. Sources from
 * wb_recoveries directly (the events row only stores per-recovery cents;
 * we want the sum). Value-delivered signal, not platform revenue — see
 * the OverviewRollup.today.mrrCents doc.
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
 * Strong-attribution MRR daily buckets for the last `days` days. Same
 * padding scheme as dailyBucketsForEvent.
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
 * 5 most-recent error events (any of ERROR_EVENT_NAMES). Used as the
 * "latest failures" tail under the Errors panel — the single biggest
 * triage shortcut on the page. Customer email is best-effort via join.
 */
async function recentErrorEvents(): Promise<OverviewRollup['errorsTail']> {
  const rows = await getDbReadOnly()
    .select({
      id:            wbEvents.id,
      name:          wbEvents.name,
      customerId:    wbEvents.customerId,
      customerEmail: users.email,
      properties:    wbEvents.properties,
      createdAt:     wbEvents.createdAt,
    })
    .from(wbEvents)
    .leftJoin(customers, eq(wbEvents.customerId, customers.id))
    .leftJoin(users,     eq(customers.userId,    users.id))
    .where(inArray(wbEvents.name, ERROR_EVENT_NAMES as unknown as string[]))
    .orderBy(sql`${wbEvents.createdAt} desc`)
    .limit(5)

  return rows.map((r) => ({
    id:            r.id,
    name:          r.name,
    customerId:    r.customerId,
    customerEmail: r.customerEmail,
    snippet:       extractErrorSnippet(r.properties),
    createdAt:     r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }))
}

/** Pull a short human-readable error message from the event properties. */
function extractErrorSnippet(props: Record<string, unknown> | null): string {
  if (!props) return ''
  // Common shapes: { error: string }, { errorMessage: string }, { message: string }
  const candidates = [
    props.error,
    props.errorMessage,
    props.message,
    props.reason,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      return c.length > 120 ? c.slice(0, 117) + '…' : c
    }
  }
  return ''
}

/**
 * 5 most-recent admin actions (wb_events with name='admin_action').
 * Powers the "recent admin activity" widget on Now — fast read of who
 * just did what across the team.
 */
async function recentAdminActions(): Promise<OverviewRollup['recentAdminActivity']> {
  // We need adminEmail (from the user that fired the action; stored on
  // wb_events.userId) AND customerEmail (from wbEvents.customerId →
  // customers → users). Two left-joins.
  const rows = await getDbReadOnly()
    .select({
      id:        wbEvents.id,
      props:     wbEvents.properties,
      adminId:   wbEvents.userId,
      customerId: wbEvents.customerId,
      createdAt: wbEvents.createdAt,
    })
    .from(wbEvents)
    .where(eq(wbEvents.name, 'admin_action'))
    .orderBy(sql`${wbEvents.createdAt} desc`)
    .limit(5)

  if (rows.length === 0) return []

  // Resolve admin emails + customer emails in one round-trip per kind.
  const adminIds    = Array.from(new Set(rows.map((r) => r.adminId).filter((x): x is string => x !== null)))
  const customerIds = Array.from(new Set(rows.map((r) => r.customerId).filter((x): x is string => x !== null)))

  const [adminRows, customerRows] = await Promise.all([
    adminIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; email: string }>)
      : getDbReadOnly().select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, adminIds)),
    customerIds.length === 0
      ? Promise.resolve([] as Array<{ id: string; email: string }>)
      : getDbReadOnly()
          .select({ id: customers.id, email: users.email })
          .from(customers)
          .innerJoin(users, eq(customers.userId, users.id))
          .where(inArray(customers.id, customerIds)),
  ])
  const adminEmailById = new Map(adminRows.map((r) => [r.id, r.email]))
  const custEmailById  = new Map(customerRows.map((r) => [r.id, r.email]))

  return rows.map((r) => {
    // The action name lives in properties.action — see audit-log-queries.
    const action = (r.props && typeof r.props === 'object' && 'action' in r.props)
      ? String((r.props as Record<string, unknown>).action ?? '')
      : ''
    return {
      id: r.id,
      action,
      adminEmail:    r.adminId    ? adminEmailById.get(r.adminId)    ?? null : null,
      customerId:    r.customerId,
      customerEmail: r.customerId ? custEmailById.get(r.customerId) ?? null : null,
      createdAt:     r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }
  })
}

/**
 * When errors red-light fires, find the customer accounting for the
 * largest share of today's errors. Used to distinguish "one noisy
 * customer" from "systemic regression" in one glance.
 *
 * Returns null when there are no errors today, when no error is tied
 * to a customer (all `customerId IS NULL`), or when the top customer
 * has ≤50% share (in which case the concentration framing is misleading).
 */
async function topCustomerByErrorsToday(): Promise<{ customerId: string; customerEmail: string | null; n: number; total: number } | null> {
  const since = startOfTodayUtc()
  const rows = await getDbReadOnly()
    .select({
      customerId: wbEvents.customerId,
      n: sql<number>`count(*)::int`,
    })
    .from(wbEvents)
    .where(and(
      inArray(wbEvents.name, ERROR_EVENT_NAMES as unknown as string[]),
      gte(wbEvents.createdAt, since),
      isNotNull(wbEvents.customerId),
    ))
    .groupBy(wbEvents.customerId)
    .orderBy(sql`count(*) desc`)
    .limit(1)
  if (rows.length === 0) return null
  const top = rows[0]
  const totalRow = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(wbEvents)
    .where(and(
      inArray(wbEvents.name, ERROR_EVENT_NAMES as unknown as string[]),
      gte(wbEvents.createdAt, since),
    ))
  const total = totalRow[0]?.n ?? 0
  if (total === 0 || top.n / total < 0.5) return null
  // Best-effort customer email (top.customerId is guaranteed non-null by the filter above)
  const customerId = top.customerId!
  const emailRow = await getDbReadOnly()
    .select({ email: users.email })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(customers.id, customerId))
    .limit(1)
  return {
    customerId,
    customerEmail: emailRow[0]?.email ?? null,
    n: top.n,
    total,
  }
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
  // 2026-05-29 — count platform_subscription_created (emitted by
  // ensurePlatformSubscription the moment a sub is written). This is the
  // true trial→paid moment in the tiered model. Previously counted
  // billing_card_captured, which fires at card capture — a step BEFORE
  // the subscription actually exists, so it could over-count abandoned
  // activations.
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, 'platform_subscription_created'), gte(wbEvents.createdAt, since)))
  return row?.n ?? 0
}

/**
 * 2026-05-29 — paywall cohort: point-in-time count of customers parked
 * past the first-save gate (activated, no sub, not on an active pilot).
 * Mirrors the predicate in isCustomerBillingHealthy so the number
 * matches who's actually being gated.
 */
async function stuckAtPaywallNow(): Promise<number> {
  const now = new Date()
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(customers)
    .where(and(
      isNotNull(customers.activatedAt),
      isNull(customers.stripeSubscriptionId),
      or(
        isNull(customers.pilotUntil),
        sql`${customers.pilotUntil} <= ${now}`,
      ),
    ))
  return row?.n ?? 0
}

/**
 * Customers with a live platform subscription, grouped by billed tier.
 * The platform's revenue mix. Only counts rows with a sub on file (a
 * stale billed_tier on a canceled customer shouldn't inflate the count).
 */
async function tierDistribution(): Promise<OverviewRollup['billing']['tierDistribution']> {
  const rows = await getDbReadOnly()
    .select({
      tier: customers.billedTier,
      n: sql<number>`count(*)::int`,
    })
    .from(customers)
    .where(isNotNull(customers.stripeSubscriptionId))
    .groupBy(customers.billedTier)

  const out = { starter: 0, growth: 0, scale: 0, enterprise: 0, custom: 0 }
  for (const r of rows) {
    if (r.tier && r.tier in out) out[r.tier as keyof typeof out] = r.n
  }
  return out
}

async function requiresSalesCount(): Promise<number> {
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(customers)
    .where(eq(customers.requiresSales, true))
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
 * Daily buckets of distinct active customers (events with non-null
 * customer_id), oldest → newest, padded to `days` entries. Powers the
 * customers_active_24h floor-light check.
 *
 * Note: buckets are calendar-day, not rolling 24h. A floor light at
 * 14:00 UTC asks "did today's daily count fall below the floor?" — the
 * calendar-day cut is the right shape.
 */
async function activeCustomersDailyBuckets(days: number): Promise<number[]> {
  const since = nDaysAgo(days - 1)
  since.setUTCHours(0, 0, 0, 0)
  const rows = await getDbReadOnly()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${wbEvents.createdAt}), 'YYYY-MM-DD')`,
      n:   sql<number>`count(distinct ${wbEvents.customerId})::int`,
    })
    .from(wbEvents)
    .where(and(
      gte(wbEvents.createdAt, since),
      sql`${wbEvents.customerId} is not null`,
    ))
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
    // 2026-05-29 — paywall cohort.
    stuckAtPaywall,
    gateClassifierSkipsToday,
    gateSendSkipsToday,
    unpauseBlockedToday,
    // 2026-05-29 — billing / revenue health.
    tierDist,
    requiresSales,
    subsCanceled7d,
    reactivations7d,
    invoiceFailedToday,
    // Red-light sparklines for the two billing signals.
    subsCanceledSpark,
    invoiceFailedSpark,
    // PR 2 additions:
    //  - errorsTail/recentAdminActivity — Now-page widgets
    //  - topErrorCustomer — concentration on the 'errors' red-light
    //  - customersActive24hSpark — floor-light: silent-zero on activity
    //
    // The 'classifications' floor light reuses emailsSpark (every send
    // corresponds to one classification in this codebase, see
    // OverviewRollup.today.classifications).
    errorsTail,
    recentAdminActivity,
    topErrorCustomer,
    customersActive24hSpark,
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
    stuckAtPaywallNow(),
    countEventsSince('classifier_skipped_billing_unhealthy', todayStart),
    countEventsSince('send_skipped_billing_unhealthy', todayStart),
    countEventsSince('customer_unpause_blocked_no_sub', todayStart),
    tierDistribution(),
    requiresSalesCount(),
    countEventsSince('platform_subscription_canceled', sevenDaysAgo),
    countEventsSince('platform_subscription_reactivated', sevenDaysAgo),
    countEventsSince('billing_invoice_failed', todayStart),
    dailyBucketsForEvent('platform_subscription_canceled', 7),
    dailyBucketsForEvent('billing_invoice_failed', 7),
    // PR 2 additions
    recentErrorEvents(),
    recentAdminActions(),
    topCustomerByErrorsToday(),
    activeCustomersDailyBuckets(7),
  ])

  // Red lights — two flavors:
  //
  //  - SPIKE: today > 3× 7d median (or > 5 when no baseline). Catches
  //    sudden anomalies — error storms, churn waves, dunning floods.
  //
  //  - FLOOR: today < 30% of 7d median, but only past noon UTC. Catches
  //    silent-zero outages (send pipeline dies, activity collapses) that
  //    the spike check is blind to — a drop is lower, not higher, than
  //    baseline. Morning hours naturally have low traffic so floor
  //    checks are suppressed until the day is half-spent.
  const nowUtcHour = new Date().getUTCHours()
  const pastNoonUtc = nowUtcHour >= 12

  const redLights: OverviewRollup['redLights'] = []

  type SpikeCheck = { metric: string; today: number; spark: number[]; label: string }
  type FloorCheck = { metric: string; today: number; spark: number[]; label: string }

  const spikeChecks: SpikeCheck[] = [
    { metric: 'errors',         today: errorsToday.total, spark: errorsSpark,        label: 'errors' },
    // Replies → handoffs swap also flows through to red-light detection.
    // A sudden handoff spike is the most useful early-warning of prompt regression.
    { metric: 'handoffs',       today: handoffsToday,     spark: handoffsSpark,      label: 'handoffs' },
    // 2026-05-29 — billing early-warnings. A churn wave (sub cancels) or a
    // dunning wave (invoice failures) is exactly the kind of thing an admin
    // wants flagged the day it starts, not discovered at month-end.
    { metric: 'subs_canceled',  today: subsCanceledSpark[subsCanceledSpark.length - 1] ?? 0,
      spark: subsCanceledSpark, label: 'platform sub cancellations' },
    { metric: 'invoice_failed', today: invoiceFailedToday, spark: invoiceFailedSpark, label: 'invoice failures' },
  ]
  const floorChecks: FloorCheck[] = [
    { metric: 'floor_emails_sent',        today: emailsSentToday,    spark: emailsSpark,             label: 'emails sent' },
    { metric: 'floor_customers_active',   today: customersActive24h, spark: customersActive24hSpark, label: 'active customers' },
  ]

  for (const c of spikeChecks) {
    const past = c.spark.slice(0, -1)  // exclude today's bucket
    const m = median(past)
    let fired = false
    if (m > 0 && c.today > 3 * m) fired = true
    else if (m === 0 && c.today > 5) fired = true   // bootstrap
    if (!fired) continue
    const summary = m > 0
      ? `${c.label} today is ${c.today.toLocaleString()} (>3× 7-day median of ${m})`
      : `${c.label} today is ${c.today.toLocaleString()} (no recent baseline)`
    const entry: OverviewRollup['redLights'][number] = {
      metric: c.metric,
      kind: 'spike',
      today: c.today,
      median7d: m,
      summary,
    }
    // Concentration only meaningful for 'errors' — for other metrics the
    // event isn't customer-scoped or the concentration query would be
    // a different join.
    if (c.metric === 'errors' && topErrorCustomer) {
      entry.concentration = {
        customerId:    topErrorCustomer.customerId,
        customerEmail: topErrorCustomer.customerEmail,
        n:             topErrorCustomer.n,
      }
    }
    redLights.push(entry)
  }

  if (pastNoonUtc) {
    for (const c of floorChecks) {
      const past = c.spark.slice(0, -1)
      const m = median(past)
      // Need a baseline to compare — floor light is a "fell relative to
      // history" signal, not a bootstrap one.
      if (m === 0) continue
      if (c.today >= 0.3 * m) continue
      const summary = c.today === 0
        ? `${c.label} is 0 today (median ${m}) — pipeline likely down`
        : `${c.label} today is ${c.today.toLocaleString()} (<30% of 7d median ${m})`
      redLights.push({
        metric: c.metric,
        kind: 'floor',
        today: c.today,
        median7d: m,
        summary,
      })
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
    paywall: {
      stuckAtPaywall,
      gateSkipsToday: gateClassifierSkipsToday + gateSendSkipsToday,
      unpauseBlockedToday,
    },
    billing: {
      tierDistribution: tierDist,
      requiresSales,
      subsCanceled7d,
      reactivations7d,
      invoiceFailedToday,
    },
    redLights,
    errorsTail,
    recentAdminActivity,
  }
}

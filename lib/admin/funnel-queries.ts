/**
 * Acquisition-funnel data for /admin/insights/funnel.
 *
 * Mirrors the self-contained, read-only style of insights-queries.ts. Two
 * shapes:
 *   - `stages[]` — the 7-stage funnel "reached within the selected window",
 *     so the window selector behaves consistently (events counted in-window;
 *     customer state-columns filtered by their own timestamp in-window).
 *   - `stuck` — CURRENT-state lists (not windowed) of merchants parked at
 *     each drop-off, for outreach. Each row carries contact email + days
 *     stuck + a deep-link target (customerId).
 *
 * Stage signals (see plan):
 *   1 landed        → wb_events 'landing_viewed'                (anonymous)
 *   2 cta           → wb_events 'cta_clicked'                   (anonymous)
 *   3 registered    → customers.createdAt
 *   4 connectScreen → wb_events 'onboarding_stripe_viewed'      (distinct customer)
 *   5 connected     → wb_events 'oauth_completed'              (distinct customer)
 *   6 activated     → customers.activatedAt
 *   7 subscribed    → wb_events 'platform_subscription_created'
 */

import { and, eq, gte, isNull, isNotNull, lt, or, sql, desc } from 'drizzle-orm'
import { type AnyPgColumn } from 'drizzle-orm/pg-core'
import { getDbReadOnly } from '../db'
import { customers, users, wbEvents } from '../schema'

export type FunnelWindow = '7d' | '30d' | '90d' | 'all'

const DAY_MS = 24 * 60 * 60 * 1000

function windowSince(w: FunnelWindow): Date {
  if (w === 'all') return new Date(0)
  const days = w === '7d' ? 7 : w === '90d' ? 90 : 30
  return new Date(Date.now() - days * DAY_MS)
}

export interface FunnelStage {
  key: string
  label: string
  value: number
}

export interface StuckMerchant {
  customerId: string
  founderName: string | null
  email: string | null
  daysStuck: number
  /** Lifetime recovered for them (cents) — only meaningful for the paywall bucket. */
  recoveredCents?: number
}

export interface FunnelData {
  window: FunnelWindow
  stages: FunnelStage[]
  ctaByLocation: Array<{ location: string; count: number }>
  stuck: {
    registeredNotViewed: StuckMerchant[]
    viewedNotConnected: StuckMerchant[]
    connectedNotActivated: StuckMerchant[]
    activatedNotSubscribed: StuckMerchant[]
  }
}

const STUCK_LIMIT = 100

// --- small helpers (self-contained, mirror insights-queries.ts) ----------

async function countEventsSince(name: string, since: Date): Promise<number> {
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, name), gte(wbEvents.createdAt, since)))
  return row?.n ?? 0
}

/** Distinct customers that produced `name` within the window (dedupes
 *  re-views / reconnects so a stage counts merchants, not raw events). */
async function distinctCustomersForEvent(name: string, since: Date): Promise<number> {
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(distinct ${wbEvents.customerId})::int` })
    .from(wbEvents)
    .where(and(eq(wbEvents.name, name), gte(wbEvents.createdAt, since), isNotNull(wbEvents.customerId)))
  return row?.n ?? 0
}

async function countCustomers(predicate: ReturnType<typeof and> | undefined): Promise<number> {
  const [row] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(customers)
    .where(predicate)
  return row?.n ?? 0
}

/** Correlated subquery: does this customer have ANY `onboarding_stripe_viewed` event? */
const hasViewedConnect = sql`exists (select 1 from ${wbEvents} e where e.customer_id = ${customers.id} and e.name = 'onboarding_stripe_viewed')`

const daysStuckFrom = (col: AnyPgColumn) =>
  sql<number>`floor(extract(epoch from (now() - ${col})) / 86400)::int`

// --- main builder --------------------------------------------------------

export async function buildAcquisitionFunnel(window: FunnelWindow = '30d'): Promise<FunnelData> {
  const since = windowSince(window)
  const now = new Date()

  const [
    landed,
    cta,
    registered,
    connectScreen,
    connected,
    activated,
    subscribed,
    ctaRows,
    registeredNotViewed,
    viewedNotConnected,
    connectedNotActivated,
    activatedNotSubscribed,
  ] = await Promise.all([
    countEventsSince('landing_viewed', since),
    countEventsSince('cta_clicked', since),
    countCustomers(gte(customers.createdAt, since)),
    distinctCustomersForEvent('onboarding_stripe_viewed', since),
    distinctCustomersForEvent('oauth_completed', since),
    countCustomers(gte(customers.activatedAt, since)),
    countEventsSince('platform_subscription_created', since),

    // CTA clicks grouped by location (within window).
    getDbReadOnly()
      .select({
        location: sql<string>`coalesce(${wbEvents.properties}->>'location', 'unknown')`,
        n: sql<number>`count(*)::int`,
      })
      .from(wbEvents)
      .where(and(eq(wbEvents.name, 'cta_clicked'), gte(wbEvents.createdAt, since)))
      .groupBy(sql`coalesce(${wbEvents.properties}->>'location', 'unknown')`)
      .orderBy(desc(sql`count(*)`)),

    // --- stuck lists (current state, not windowed) ---
    // Registered but never reached the connect screen (rare — onboarding
    // redirects there; flags a pre-onboarding drop / broken redirect).
    stuckList(
      and(isNull(customers.stripeAccountId), sql`not ${hasViewedConnect}`),
      customers.createdAt,
    ),
    // Reached the connect screen but didn't connect Stripe.
    stuckList(
      and(isNull(customers.stripeAccountId), hasViewedConnect),
      customers.createdAt,
    ),
    // Connected Stripe but no first recovery yet (often legit — awaiting churn).
    stuckList(
      and(isNotNull(customers.stripeAccountId), isNull(customers.activatedAt)),
      customers.createdAt,
    ),
    // Activated (recovery delivered) but not subscribed, pilot expired —
    // "stuck at paywall". Same predicate as insights-queries.ts stuckAtPaywall.
    stuckList(
      and(
        isNotNull(customers.activatedAt),
        isNull(customers.stripeSubscriptionId),
        or(isNull(customers.pilotUntil), lt(customers.pilotUntil, now)),
      ),
      customers.activatedAt,
      /* withRecovered */ true,
    ),
  ])

  const stages: FunnelStage[] = [
    { key: 'landed',        label: 'Landed',         value: landed },
    { key: 'cta',           label: 'Clicked CTA',    value: cta },
    { key: 'registered',    label: 'Registered',     value: registered },
    { key: 'connectScreen', label: 'Connect screen', value: connectScreen },
    { key: 'connected',     label: 'Connected',      value: connected },
    { key: 'activated',     label: 'Activated',      value: activated },
    { key: 'subscribed',    label: 'Subscribed',     value: subscribed },
  ]

  return {
    window,
    stages,
    ctaByLocation: ctaRows.map((r) => ({ location: r.location, count: r.n })),
    stuck: { registeredNotViewed, viewedNotConnected, connectedNotActivated, activatedNotSubscribed },
  }
}

/** Shared stuck-list query: contact email (notificationEmail ?? user email),
 *  days stuck from `sinceCol`, newest-stuck first, capped at STUCK_LIMIT. */
async function stuckList(
  predicate: ReturnType<typeof and>,
  sinceCol: AnyPgColumn,
  withRecovered = false,
): Promise<StuckMerchant[]> {
  const rows = await getDbReadOnly()
    .select({
      customerId: customers.id,
      founderName: customers.founderName,
      email: sql<string | null>`coalesce(${customers.notificationEmail}, ${users.email})`,
      daysStuck: daysStuckFrom(sinceCol),
      recoveredCents: withRecovered
        ? sql<number>`${customers.cumulativeRevenueSavedCents}::int`
        : sql<number>`0`,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(predicate)
    .orderBy(desc(daysStuckFrom(sinceCol)))
    .limit(STUCK_LIMIT)

  return rows.map((r) => ({
    customerId: r.customerId,
    founderName: r.founderName,
    email: r.email,
    daysStuck: Number(r.daysStuck ?? 0),
    ...(withRecovered ? { recoveredCents: Number(r.recoveredCents ?? 0) } : {}),
  }))
}

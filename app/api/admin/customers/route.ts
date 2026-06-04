import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { customers, users, churnedSubscribers, recoveries, wbEvents } from '@/lib/schema'
import { and, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql, desc } from 'drizzle-orm'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * GET /api/admin/customers?q=...&filter=...&limit=50
 *
 * Cross-customer list for /admin/customers. Search matches founder email,
 * founder name, product name, or Stripe account id (ILIKE).
 *
 * Filter values (all match the /admin Now stuck-cohort tiles so each
 * tile click-through lands on the matching row set):
 *  - `stuck_on_signup`     — registered but never connected Stripe (Spec 30)
 *  - `paywall_stuck`       — activated, no platform sub, not on active pilot
 *  - `oauth_issues`        — 3+ oauth_error events in last 24h
 *  - `backfill_in_flight`  — backfill started, not yet completed
 *
 * Returns counts and last-activity timestamp per row.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { searchParams } = req.nextUrl
  const q = (searchParams.get('q') ?? '').trim()
  const filter = searchParams.get('filter') ?? ''
  const limit = Math.min(Number(searchParams.get('limit')) || 50, 200)

  const filters = []
  if (q) {
    const pat = `%${q}%`
    const cond = or(
      ilike(users.email, pat),
      ilike(customers.founderName, pat),
      ilike(customers.productName, pat),
      ilike(customers.stripeAccountId, pat),
    )
    if (cond) filters.push(cond)
  }
  // Spec 30 — "Stuck on signup": registered but never connected Stripe.
  if (filter === 'stuck_on_signup') {
    filters.push(isNull(customers.stripeAccountId))
  }
  // PR 2 — Paywall-stuck cohort: matches buildStuckCohorts.paywallStuck.
  // Activated customer, no platform sub, not on an active pilot.
  if (filter === 'paywall_stuck') {
    const now = new Date()
    filters.push(and(
      isNotNull(customers.activatedAt),
      isNull(customers.stripeSubscriptionId),
      or(
        isNull(customers.pilotUntil),
        lt(customers.pilotUntil, now),
      ),
    )!)
  }
  // PR 2 — Backfill-in-flight cohort: matches buildStuckCohorts.backfillInFlight.
  if (filter === 'backfill_in_flight') {
    filters.push(and(
      isNotNull(customers.backfillStartedAt),
      isNull(customers.backfillCompletedAt),
    )!)
  }
  // PR 2 — OAuth-issues cohort: customer_id IN (subquery for 3+ errors in 24h).
  // Subquery matches buildStuckCohorts.oauthIssues.
  if (filter === 'oauth_issues') {
    const twentyFourHoursAgo = new Date(Date.now() - DAY_MS)
    const oauthCustomerIdsSubquery = getDbReadOnly()
      .select({ id: wbEvents.customerId })
      .from(wbEvents)
      .where(and(
        eq(wbEvents.name, 'oauth_error'),
        gte(wbEvents.createdAt, twentyFourHoursAgo),
        isNotNull(wbEvents.customerId),
      ))
      .groupBy(wbEvents.customerId)
      .having(sql`count(*) >= 3`)
    filters.push(inArray(customers.id, oauthCustomerIdsSubquery))
  }
  // PR 2 — Webhook-silent cohort: matches buildStuckCohorts.webhookSilent.
  // Stripe-connected + activated, produced events before, none in 24h.
  if (filter === 'webhook_silent') {
    const twentyFourHoursAgo = new Date(Date.now() - DAY_MS)
    filters.push(and(
      isNotNull(customers.stripeAccessToken),
      isNotNull(customers.activatedAt),
      sql`exists (select 1 from wb_events e where e.customer_id = ${customers.id})`,
      sql`not exists (select 1 from wb_events e where e.customer_id = ${customers.id} and e.created_at > ${twentyFourHoursAgo})`,
    )!)
  }

  const rows = await getDbReadOnly()
    .select({
      id: customers.id,
      email: users.email,
      founderName: customers.founderName,
      productName: customers.productName,
      plan: customers.plan,
      stripeConnected: sql<boolean>`${customers.stripeAccessToken} is not null`,
      stripeAccountId: customers.stripeAccountId,
      pausedAt: customers.pausedAt,
      subsCount: sql<number>`(
        select count(*)::int from ${churnedSubscribers}
        where ${churnedSubscribers.customerId} = ${customers.id}
      )`,
      recoveriesCount: sql<number>`(
        select count(*)::int from ${recoveries}
        where ${recoveries.customerId} = ${customers.id}
      )`,
      lastEventAt: sql<Date | null>`(
        select max(${wbEvents.createdAt}) from ${wbEvents}
        where ${wbEvents.customerId} = ${customers.id}
      )`,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(customers.createdAt))
    .limit(limit)

  return NextResponse.json({ rows, total: rows.length })
}

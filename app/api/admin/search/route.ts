import { NextRequest, NextResponse } from 'next/server'
import { desc, eq, ilike, or, sql } from 'drizzle-orm'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import { customers, users, churnedSubscribers, wbEvents } from '@/lib/schema'

/**
 * GET /api/admin/search?q=...
 *
 * Combined search for the Cmd-K palette. Returns up to LIMIT_PER_KIND
 * matches in each of three kinds (customers, subscribers, recent
 * events) in a single round-trip. Used by components/admin/cmdk-palette.
 *
 * Matching:
 *  - customers:   ilike on user.email, founderName, productName, stripeAccountId
 *  - subscribers: ilike on subscriber email or name, joined with customer for label
 *  - events:      ilike on event name OR on the joined customer email
 *
 * Empty / too-short queries (<2 chars) return empty arrays without
 * hitting the DB.
 *
 * All queries hit existing indexes:
 *  - users.email is uniquely indexed
 *  - wb_events has (name, created_at) and (customer_id, created_at)
 *  - ilike on small text columns over the customer table is acceptable
 *    at current scale (~hundreds of merchants); revisit if scale 10x's.
 */
const LIMIT_PER_KIND = 8

export async function GET(req: NextRequest) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  if (q.length < 2) {
    return NextResponse.json({ customers: [], subscribers: [], events: [] })
  }

  const db = getDbReadOnly()
  const pat = `%${q}%`

  try {
  // Fan out — three independent queries, max wall-clock = slowest.
  const [customerRows, subscriberRows, eventRows] = await Promise.all([
    db.select({
      id:              customers.id,
      email:           users.email,
      founderName:     customers.founderName,
      productName:     customers.productName,
      plan:            customers.plan,
      stripeConnected: sql<boolean>`${customers.stripeAccessToken} is not null`,
    })
      .from(customers)
      .innerJoin(users, eq(customers.userId, users.id))
      .where(or(
        ilike(users.email,              pat),
        ilike(customers.founderName,    pat),
        ilike(customers.productName,    pat),
        ilike(customers.stripeAccountId, pat),
      ))
      .orderBy(desc(customers.createdAt))
      .limit(LIMIT_PER_KIND),

    db.select({
      id:                   churnedSubscribers.id,
      customerId:           churnedSubscribers.customerId,
      customerEmail:        users.email,
      customerProductName:  customers.productName,
      customerFounderName:  customers.founderName,
      email:                churnedSubscribers.email,
      name:                 churnedSubscribers.name,
      status:               churnedSubscribers.status,
      doNotContact:         churnedSubscribers.doNotContact,
      cancelledAt:          churnedSubscribers.cancelledAt,
    })
      .from(churnedSubscribers)
      .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
      .innerJoin(users,     eq(customers.userId,              users.id))
      .where(or(
        ilike(churnedSubscribers.email, pat),
        ilike(churnedSubscribers.name,  pat),
      ))
      .orderBy(desc(churnedSubscribers.cancelledAt))
      .limit(LIMIT_PER_KIND),

    db.select({
      id:            wbEvents.id,
      name:          wbEvents.name,
      customerId:    wbEvents.customerId,
      customerEmail: users.email,
      createdAt:     wbEvents.createdAt,
    })
      .from(wbEvents)
      .leftJoin(customers, eq(wbEvents.customerId, customers.id))
      .leftJoin(users,     eq(customers.userId,    users.id))
      .where(or(
        ilike(wbEvents.name, pat),
        ilike(users.email,   pat),
      ))
      .orderBy(desc(wbEvents.createdAt))
      .limit(LIMIT_PER_KIND),
  ])

  return NextResponse.json({
    customers: customerRows.map((c) => ({
      id:              c.id,
      email:           c.email,
      founderName:     c.founderName,
      productName:     c.productName,
      plan:            c.plan,
      stripeConnected: Boolean(c.stripeConnected),
    })),
    subscribers: subscriberRows.map((s) => ({
      id:           s.id,
      customerId:   s.customerId,
      // Best-effort label: product → founder → email
      customerLabel: s.customerProductName ?? s.customerFounderName ?? s.customerEmail,
      email:        s.email,
      name:         s.name,
      status:       s.status,
      doNotContact: s.doNotContact,
    })),
    events: eventRows.map((e) => ({
      id:            e.id,
      name:          e.name,
      customerId:    e.customerId,
      customerEmail: e.customerEmail,
      createdAt:     e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
    })),
  })
  } catch (err) {
    console.error('[admin/search] failed', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Search failed' },
      { status: 500 },
    )
  }
}

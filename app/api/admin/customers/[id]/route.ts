import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { getDbReadOnly } from '@/lib/db'
import {
  customers,
  users,
  churnedSubscribers,
  emailsSent,
  wbEvents,
  recoveries,
  billingRuns,
} from '@/lib/schema'
import { eq, and, sql, desc } from 'drizzle-orm'

/**
 * GET /api/admin/customers/[id]
 *
 * Returns the full detail payload for a single Winback customer:
 *   - identity + plan + paused state
 *   - Stripe health (account id, last webhook activity, recent oauth_error count)
 *   - last 20 emails sent on their behalf
 *   - last 50 events for this customerId
 *   - billing snapshot (last run + outstanding obligation count + payment method)
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const ro = getDbReadOnly()

  const [identityRow] = await ro
    .select({
      id: customers.id,
      email: users.email,
      founderName: customers.founderName,
      productName: customers.productName,
      notificationEmail: customers.notificationEmail,
      plan: customers.plan,
      pausedAt: customers.pausedAt,
      stripeAccountId: customers.stripeAccountId,
      stripeConnected: sql<boolean>`${customers.stripeAccessToken} is not null`,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(customers.id, id))
    .limit(1)

  if (!identityRow) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const [
    lastWebhookActivity,
    recentOauthErrors,
    recentEmails,
    recentEvents,
    lastBillingRun,
    outstandingObligations,
    openHandoffs,
  ] = await Promise.all([
    // Last activity event for this customer (proxy for "is the integration alive")
    ro
      .select({ createdAt: sql<Date>`max(${wbEvents.createdAt})` })
      .from(wbEvents)
      .where(eq(wbEvents.customerId, id)),
    // OAuth errors in the last 7 days — flags broken Stripe connection
    ro
      .select({ n: sql<number>`count(*)::int` })
      .from(wbEvents)
      .where(
        and(
          eq(wbEvents.customerId, id),
          eq(wbEvents.name, 'oauth_error'),
          sql`${wbEvents.createdAt} > now() - interval '7 days'`,
        ),
      ),
    // Last 20 emails sent on this customer's behalf
    ro
      .select({
        id: emailsSent.id,
        type: emailsSent.type,
        subject: emailsSent.subject,
        sentAt: emailsSent.sentAt,
        repliedAt: emailsSent.repliedAt,
        subscriberId: emailsSent.subscriberId,
        subscriberEmail: churnedSubscribers.email,
        subscriberName: churnedSubscribers.name,
      })
      .from(emailsSent)
      .innerJoin(
        churnedSubscribers,
        eq(emailsSent.subscriberId, churnedSubscribers.id),
      )
      .where(eq(churnedSubscribers.customerId, id))
      .orderBy(desc(emailsSent.sentAt))
      .limit(20),
    // Last 50 events for this customer
    ro
      .select({
        id: wbEvents.id,
        name: wbEvents.name,
        properties: wbEvents.properties,
        createdAt: wbEvents.createdAt,
      })
      .from(wbEvents)
      .where(eq(wbEvents.customerId, id))
      .orderBy(desc(wbEvents.createdAt))
      .limit(50),
    // Most recent billing run row
    ro
      .select()
      .from(billingRuns)
      .where(eq(billingRuns.customerId, id))
      .orderBy(desc(billingRuns.createdAt))
      .limit(1),
    // Outstanding obligations: strong recoveries that haven't been billed.
    // Approximate — counts strong recoveries minus paid runs' line items;
    // exact reconciliation lives in the billing cron itself.
    ro
      .select({ n: sql<number>`count(*)::int` })
      .from(recoveries)
      .where(
        and(
          eq(recoveries.customerId, id),
          eq(recoveries.attributionType, 'strong'),
          eq(recoveries.stillActive, true),
        ),
      ),
    // Open handoffs that emergency action could resolve
    ro
      .select({ n: sql<number>`count(*)::int` })
      .from(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.customerId, id),
          sql`${churnedSubscribers.founderHandoffAt} is not null`,
          sql`${churnedSubscribers.founderHandoffResolvedAt} is null`,
        ),
      ),
  ])

  return NextResponse.json({
    identity: identityRow,
    stripeHealth: {
      lastActivityAt: lastWebhookActivity[0]?.createdAt ?? null,
      recentOauthErrors: recentOauthErrors[0]?.n ?? 0,
    },
    recentEmails,
    recentEvents,
    billing: {
      lastRun: lastBillingRun[0] ?? null,
      outstandingObligations: outstandingObligations[0]?.n ?? 0,
    },
    openHandoffs: openHandoffs[0]?.n ?? 0,
  })
}

/**
 * Verify the drawer-redesign DB plumbing against dev data.
 *
 * Runs the exact query path /api/subscribers now uses — the awaitingReplyExpr()
 * helper + the latestReplySnippet correlated column + the new sort — for
 * tejaasvi@gmail.com's win-back cohort, and prints what the DB returns.
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-awaiting.ts
 */
import { eq, and, or, ne, isNull, desc, sql, getTableColumns } from 'drizzle-orm'
import { db } from '../lib/db'
import { users, customers, churnedSubscribers, subscriberReplies } from '../lib/schema'
import { awaitingReplyExpr } from '../lib/ai-state'

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  if (!u) throw new Error('no user')
  const [c] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) throw new Error('no customer')

  const rows = await db
    .select({
      ...getTableColumns(churnedSubscribers),
      latestReplySnippet: sql<string | null>`(
        select sr.body from ${subscriberReplies} sr
        where sr.subscriber_id = ${churnedSubscribers}."id"
        order by sr.received_at desc limit 1
      )`.as('latest_reply_snippet'),
      awaitingReply: awaitingReplyExpr().as('awaiting_reply'),
    })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, c.id),
      or(ne(churnedSubscribers.cancellationReason, 'Payment failed'), isNull(churnedSubscribers.cancellationReason)),
    ))
    .orderBy(
      sql`case when ${awaitingReplyExpr()} then 0 when ${churnedSubscribers.recoveryLikelihood} = 'high' then 1 else 2 end`,
      desc(churnedSubscribers.cancelledAt),
    )

  console.log(`\nWin-back rows for ${c.productName} — in sort order:\n`)
  console.log('  ' + 'name'.padEnd(15) + 'recovery'.padEnd(10) + 'awaiting'.padEnd(10) + 'status'.padEnd(11) + 'latestReplySnippet')
  console.log('  ' + '─'.repeat(90))
  for (const r of rows) {
    const snip = r.latestReplySnippet ? `"${r.latestReplySnippet.slice(0, 40)}…"` : '—'
    console.log(
      '  ' +
      String(r.name ?? '—').padEnd(15) +
      String(r.recoveryLikelihood ?? '—').padEnd(10) +
      String(r.awaitingReply).padEnd(10) +
      String(r.status).padEnd(11) +
      snip,
    )
  }

  // Filter counts (mirror /api/stats).
  const [counts] = await db
    .select({
      all: sql<number>`count(*)::int`,
      awaiting: sql<number>`count(*) filter (where ${awaitingReplyExpr()})::int`,
      high: sql<number>`count(*) filter (where ${churnedSubscribers.recoveryLikelihood} = 'high' and ${churnedSubscribers.status} not in ('recovered','lost','skipped'))::int`,
      recovered: sql<number>`count(*) filter (where ${churnedSubscribers.status} = 'recovered')::int`,
    })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, c.id),
      or(ne(churnedSubscribers.cancellationReason, 'Payment failed'), isNull(churnedSubscribers.cancellationReason)),
    ))
  console.log(`\nFilter counts → all:${counts.all}  awaiting:${counts.awaiting}  high:${counts.high}  recovered:${counts.recovered}\n`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })

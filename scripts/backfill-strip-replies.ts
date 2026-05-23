/**
 * One-off: re-strip already-stored inbound replies for tejaasvi@gmail.com's
 * subscribers using the same stripQuotedReply() the inbound route now uses.
 * Cleans rows captured before the strip fix landed.
 *
 * Usage: npx tsx --env-file=.env.local scripts/backfill-strip-replies.ts
 */
import { eq, inArray } from 'drizzle-orm'
import { db } from '../lib/db'
import { users, customers, churnedSubscribers, subscriberReplies } from '../lib/schema'
import { stripQuotedReply } from '../src/winback/lib/strip-quoted-reply'

async function main() {
  const [u] = await db.select().from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  if (!u) throw new Error('no user')
  const [c] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) throw new Error('no customer')

  const subs = await db.select({ id: churnedSubscribers.id }).from(churnedSubscribers).where(eq(churnedSubscribers.customerId, c.id))
  const ids = subs.map((s) => s.id)
  if (ids.length === 0) { console.log('No subscribers.'); process.exit(0) }

  const replies = await db.select().from(subscriberReplies).where(inArray(subscriberReplies.subscriberId, ids))
  let changed = 0
  for (const r of replies) {
    const cleaned = stripQuotedReply(r.body)
    if (cleaned && cleaned !== r.body) {
      await db.update(subscriberReplies).set({ body: cleaned }).where(eq(subscriberReplies.id, r.id))
      changed++
      console.log(`\n[${r.id}]`)
      console.log(`  before: ${JSON.stringify(r.body.slice(0, 120))}…`)
      console.log(`  after : ${JSON.stringify(cleaned.slice(0, 120))}`)
    }
  }
  console.log(`\nDone. ${changed}/${replies.length} replies cleaned.`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })

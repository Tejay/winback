// Companion to scripts/test-cancellation-e2e.ts.
//
// After the cancellation script prints "Subscriber UUID: <id>", run:
//   tsx --env-file=.env.local scripts/test-cancellation-replies.ts <subscriberId>
//
// Inserts 3 inbound replies into wb_subscriber_replies on a 1-second delta
// so the dashboard drawer's conversation renderer has something realistic
// to display. Does NOT trigger the classifier — keeps the test focused on
// rendering. Each reply uses a distinct timestamp so ordering can be
// validated against the outbound exit email.

import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from '../lib/db'
import { churnedSubscribers, subscriberReplies } from '../lib/schema'

const REPLIES: string[] = [
  // Reply 1 — picks up the price thread, hints at a discount that would change the math
  "I appreciate the personal note. Look, if you could land us at $59/mo for the team (or a 20% annual prepay) I'd seriously reconsider — the workflow is genuinely good, the math just doesn't work at current pricing.",
  // Reply 2 — adds an adoption/feature angle so the AI has more to chew on
  "Also — what would really move the needle is if the Slack digest pulled in unfinished tasks. Half the team forgets to open the app. We tried the email digest but it gets buried.",
  // Reply 3 — softens the tone, leaves a door open
  "Anyway — not in a rush, just being upfront. If you do put together an annual offer for sub-10-seat teams, ping me. Otherwise no hard feelings.",
]

async function main(): Promise<void> {
  const subscriberId = process.argv[2]
  if (!subscriberId) {
    console.error('Usage: tsx --env-file=.env.local scripts/test-cancellation-replies.ts <subscriberId>')
    process.exit(1)
  }

  const [sub] = await db
    .select({ id: churnedSubscribers.id, email: churnedSubscribers.email, name: churnedSubscribers.name })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!sub) {
    console.error(`No subscriber found with id=${subscriberId}`)
    process.exit(1)
  }

  console.log(`Inserting ${REPLIES.length} replies for ${sub.name ?? sub.email ?? subscriberId}\n`)

  // Stagger timestamps so the conversation renders in a coherent order.
  // Replies are inserted strictly after "now" so they sort after the
  // already-sent exit email (which has sentAt = a few seconds ago).
  const base = Date.now()
  for (let i = 0; i < REPLIES.length; i++) {
    const receivedAt = new Date(base + i * 1000)
    await db.insert(subscriberReplies).values({
      subscriberId,
      body:       REPLIES[i],
      fromEmail:  sub.email,
      receivedAt,
    })
    console.log(`  ✓ reply ${i + 1} inserted (${receivedAt.toISOString()})`)
  }

  console.log(`\nOpen the dashboard, click the subscriber, and check the Email history section.`)
}

main()
  .catch((err) => {
    console.error('Replies insert crashed:', err)
    process.exit(1)
  })
  .finally(() => process.exit(0))

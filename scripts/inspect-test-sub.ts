// Inspect the current state of the cancel-test subscriber:
// - subscriber row (status, handoff, AI pause)
// - all outbound emails (wb_emails_sent)
// - all inbound replies (wb_subscriber_replies)
// Sorted chronologically so the conversation reads naturally.
import 'dotenv/config'
import { asc, eq } from 'drizzle-orm'
import { db } from '../lib/db'
import { churnedSubscribers, emailsSent, subscriberReplies } from '../lib/schema'

const SUB_ID = process.argv[2]
if (!SUB_ID) {
  console.error('Usage: tsx --env-file=.env.local scripts/inspect-test-sub.ts <subscriberId>')
  process.exit(1)
}

async function main(): Promise<void> {
  const [sub] = await db.select().from(churnedSubscribers).where(eq(churnedSubscribers.id, SUB_ID)).limit(1)
  if (!sub) { console.error('not found'); process.exit(1) }

  console.log('=== Subscriber ===')
  console.log({
    id:                  sub.id,
    status:              sub.status,
    tier:                sub.tier,
    confidence:          sub.confidence,
    cancellationReason:  sub.cancellationReason,
    cancellationCategory: sub.cancellationCategory,
    triggerNeed:         sub.triggerNeed,
    triggerKeyword:      sub.triggerKeyword,
    founderHandoffAt:    sub.founderHandoffAt,
    founderHandoffResolvedAt: sub.founderHandoffResolvedAt,
    aiPausedUntil:       sub.aiPausedUntil,
    aiPausedReason:      sub.aiPausedReason,
    handoffReasoning:    sub.handoffReasoning,
    recoveryLikelihood:  sub.recoveryLikelihood,
    classifiedAt:        sub.classifiedAt,
    updatedAt:           sub.updatedAt,
  })

  const outbound = await db
    .select()
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, SUB_ID))
    .orderBy(asc(emailsSent.sentAt))
  const inbound = await db
    .select()
    .from(subscriberReplies)
    .where(eq(subscriberReplies.subscriberId, SUB_ID))
    .orderBy(asc(subscriberReplies.receivedAt))

  console.log(`\n=== Conversation (${outbound.length} outbound, ${inbound.length} inbound) ===`)
  type Msg =
    | { kind: 'out'; t: Date; type: string; subject: string | null; body: string | null; repliedAt: Date | null }
    | { kind: 'in';  t: Date; from: string | null; body: string }
  const msgs: Msg[] = [
    ...outbound.map((e): Msg => ({ kind: 'out', t: e.sentAt ?? new Date(0), type: e.type, subject: e.subject, body: e.bodyText, repliedAt: e.repliedAt })),
    ...inbound.map((r): Msg => ({ kind: 'in',  t: r.receivedAt, from: r.fromEmail, body: r.body })),
  ].sort((a, b) => a.t.getTime() - b.t.getTime())

  for (const m of msgs) {
    const ts = m.t.toISOString()
    if (m.kind === 'out') {
      console.log(`\n[OUT ${ts}] ${m.type} · "${m.subject ?? '(no subj)'}"${m.repliedAt ? ' · replied=' + m.repliedAt.toISOString() : ''}`)
      console.log((m.body ?? '(no body)').split('\n').map((l) => '  ' + l).join('\n'))
    } else {
      console.log(`\n[IN  ${ts}] from=${m.from ?? '?'}`)
      console.log(m.body.split('\n').map((l) => '  ' + l).join('\n'))
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => process.exit(0))

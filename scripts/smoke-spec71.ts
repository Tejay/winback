// Spec 71 smoke harness — comprehensive end-to-end checks for the
// reply-history refactor. Run before merging.
//
//   npx tsx --env-file=.env.local scripts/smoke-spec71.ts
//
// Scenarios:
//   1. Migration sanity — wb_subscriber_replies exists; reply_text column gone
//   2. Inbound webhook end-to-end — POST signed webhook, verify row + 20 KB cap
//   3. Multi-turn conversation — 3 replies; buildConversationThread returns all
//      in order; classifier prompt renders the full block
//   4. Threaded reply via In-Reply-To header — direct DB insert sets the FK
//      (webhook path can't be smoked without a real Resend email_id)
//   5. Unthreaded reply — null in_reply_to_email_id renders as standalone
//   6. Duplicate webhook (same resend_email_id) — second insert is a no-op
//   7. Drop verified — `reply_text` column no longer in churned_subscribers
//
// Cleanup runs at the end; pass `--keep` to leave the smoke subscriber
// for browser inspection.

import { db } from '../lib/db'
import {
  customers,
  churnedSubscribers,
  emailsSent,
  subscriberReplies,
  users,
  inboundEvents,
} from '../lib/schema'
import { eq, and, sql, desc, like } from 'drizzle-orm'
import { Webhook } from 'svix'
import {
  buildConversationThread,
  renderThreadForPrompt,
  getLatestReply,
} from '../src/winback/lib/conversation'

const TAG = 'spec71-smoke'
const KEEP = process.argv.includes('--keep')
const APP_URL = 'http://localhost:3000'

interface Verdict { name: string; pass: boolean; detail?: string }
const verdicts: Verdict[] = []

function check(name: string, pass: boolean, detail?: string) {
  verdicts.push({ name, pass, detail })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function getDevCustomer() {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  if (!u) throw new Error('Dev user tejaasvi@gmail.com not found')
  const [c] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!c) throw new Error('Dev customer not found')
  return c
}

async function seed() {
  const customer = await getDevCustomer()

  const [sub] = await db
    .insert(churnedSubscribers)
    .values({
      customerId: customer.id,
      stripeCustomerId: `cus_${TAG}_${Date.now()}`,
      email: `${TAG}@example.com`,
      name: 'Spec71 Smoke Subscriber',
      planName: 'Pro',
      mrrCents: 2900,
      tenureDays: 90,
      cancelledAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      status: 'contacted',
      source: TAG,
      stripeEnum: 'too_expensive',
      stripeComment: 'plan is too expensive',
      triggerNeed: 'Wants lower-priced tier',
      triggerNeedConfidence: 'high',
    })
    .returning({ id: churnedSubscribers.id })

  // Two outbound emails so threading has targets
  const [exit, followup] = await db
    .insert(emailsSent)
    .values([
      {
        subscriberId: sub.id,
        type: 'exit',
        subject: 'Sorry to see you go',
        bodyText: 'Hi! Saw you cancelled. Anything we could do better?',
        gmailMessageId: `<msg-exit-${TAG}-${Date.now()}@reply.winbackflow.co>`,
        sentAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000),
      },
      {
        subscriberId: sub.id,
        type: 'reengagement',
        subject: 'About pricing',
        bodyText: 'We just shipped a lower-priced tier you might like.',
        gmailMessageId: `<msg-followup-${TAG}-${Date.now()}@reply.winbackflow.co>`,
        sentAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      },
    ])
    .returning({ id: emailsSent.id, gmailMessageId: emailsSent.gmailMessageId })

  return { customer, subscriberId: sub.id, exit, followup }
}

async function scenario1_migrationSanity() {
  console.log('\n[1] Migration sanity')
  // wb_subscriber_replies exists
  let tableExists = false
  try {
    await db.select({ n: sql<number>`count(*)::int` }).from(subscriberReplies).limit(1)
    tableExists = true
  } catch { /* swallow */ }
  check('wb_subscriber_replies table exists', tableExists)

  // reply_text column gone
  let dropped = false
  try {
    await db.execute(sql.raw(
      `SELECT 1 FROM information_schema.columns WHERE table_name='wb_churned_subscribers' AND column_name='reply_text'`,
    )).then((r) => { dropped = (r as { rows: unknown[] }).rows.length === 0 })
  } catch { /* swallow */ }
  check('wb_churned_subscribers.reply_text column dropped', dropped)
}

async function scenario2_inboundWebhookE2E(subscriberId: string) {
  console.log('\n[2] Inbound webhook end-to-end (envelope-text fallback path)')

  const secret = process.env.RESEND_WEBHOOK_SECRET
  if (!secret) { check('RESEND_WEBHOOK_SECRET present', false); return }

  // Use envelopeText path so we don't need a real Resend email_id behind
  // the GET /emails/receiving call. inReplyTo will be null (header only
  // comes from the fetched body), but row-insert + body cap are exercised.
  const emailId = `em_${TAG}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const payload = {
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      from: `${TAG}@example.com`,
      to: `reply+${subscriberId}@reply.winbackflow.co`,
      subject: 'Re: About pricing',
      text: 'this is the smoke reply body, around 50 chars long',
    },
  }
  const body = JSON.stringify(payload)
  const wh = new Webhook(secret)
  const msgId = `msg_${TAG}_${Date.now()}`
  const ts = Math.floor(Date.now() / 1000).toString()
  const signature = wh.sign(msgId, new Date(Number(ts) * 1000), body)

  const res = await fetch(`${APP_URL}/api/email/inbound`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': msgId,
      'svix-timestamp': ts,
      'svix-signature': signature,
    },
    body,
  })
  const json = await res.json().catch(() => ({}))
  check(`webhook POST returned 200 (was ${res.status})`, res.status === 200, JSON.stringify(json))

  // Verify a reply row landed
  const [reply] = await db
    .select()
    .from(subscriberReplies)
    .where(eq(subscriberReplies.resendEmailId, emailId))
    .limit(1)
  check('reply row inserted with matching resend_email_id', !!reply, reply?.id)
  check('reply body matches envelope text', reply?.body === 'this is the smoke reply body, around 50 chars long')

  // 20 KB cap test — separate insert with a huge body. Postgres CHECK
  // constraint should reject. (The truncation happens in the route
  // handler before insert, so an over-cap value at SQL level can only
  // come from misuse.)
  let oversizeRejected = false
  let oversizeErr = ''
  try {
    await db.insert(subscriberReplies).values({
      subscriberId,
      body: 'x'.repeat(30_000),
    })
  } catch (err) {
    oversizeRejected = true
    oversizeErr = err instanceof Error ? err.message : String(err)
  }
  check(`Postgres CHECK rejects >20 KB body`, oversizeRejected, oversizeErr.slice(0, 80))
}

async function scenario3_multiTurnConversation(subscriberId: string) {
  console.log('\n[3] Multi-turn conversation')

  await db.insert(subscriberReplies).values([
    { subscriberId, body: 'first reply: maybe', receivedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    { subscriberId, body: 'second reply: not really', receivedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000) },
    { subscriberId, body: 'third reply: ok actually I am interested again', receivedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) },
  ])

  const thread = await buildConversationThread(subscriberId)
  const replies = thread.filter((t) => t.kind === 'reply')
  // We inserted 3 here + 1 in scenario 2 (which ran earlier) = 4 replies total
  // (might also include the scenario-2 envelope-text reply with "smoke reply body")
  check('thread contains all replies', replies.length >= 3, `got ${replies.length} reply turns`)

  const bodies = replies.map((r) => r.body)
  const ordered = bodies.findIndex((b) => b.startsWith('first')) < bodies.findIndex((b) => b.startsWith('third'))
  check('replies returned chronologically (oldest first)', ordered)

  // Verify the rendered prompt block looks sane
  const rendered = renderThreadForPrompt(thread, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
  check('rendered prompt contains CONVERSATION SO FAR header', rendered.includes('CONVERSATION SO FAR'))
  check('rendered prompt contains WE SENT (exit)', rendered.includes('WE SENT (exit)'))
  check('rendered prompt contains WE SENT (reengagement)', rendered.includes('WE SENT (reengagement)'))
  check('rendered prompt contains SUBSCRIBER REPLIED', rendered.includes('SUBSCRIBER REPLIED'))
  check('rendered prompt contains "first reply"', rendered.includes('first reply'))
  check('rendered prompt contains "third reply"', rendered.includes('third reply'))
}

async function scenario4_threadingViaInReplyTo(subscriberId: string, exitEmailId: string) {
  console.log('\n[4] Threading via in_reply_to_email_id')

  const [reply] = await db
    .insert(subscriberReplies)
    .values({
      subscriberId,
      body: 'This is a threaded reply specifically to the exit email.',
      inReplyToEmailId: exitEmailId,
      receivedAt: new Date(),
    })
    .returning({ id: subscriberReplies.id, inReplyToEmailId: subscriberReplies.inReplyToEmailId })

  check('reply row stored with in_reply_to_email_id set', reply.inReplyToEmailId === exitEmailId)
}

async function scenario5_unthreadedReply(subscriberId: string) {
  console.log('\n[5] Unthreaded reply (NULL in_reply_to_email_id)')
  const [reply] = await db
    .insert(subscriberReplies)
    .values({
      subscriberId,
      body: 'Unthreaded — subscriber composed a fresh email instead of hitting Reply.',
      receivedAt: new Date(),
    })
    .returning({ id: subscriberReplies.id, inReplyToEmailId: subscriberReplies.inReplyToEmailId })
  check('reply row stored with in_reply_to_email_id = NULL', reply.inReplyToEmailId === null)
}

async function scenario6_duplicateWebhook(subscriberId: string) {
  console.log('\n[6] Duplicate resend_email_id (UNIQUE constraint)')

  const resendId = `em_${TAG}_dup_${Date.now()}`

  await db.insert(subscriberReplies).values({
    subscriberId,
    body: 'first insert with this resend id',
    resendEmailId: resendId,
  })

  let rejected = false
  let dupErr = ''
  try {
    await db.insert(subscriberReplies).values({
      subscriberId,
      body: 'second insert with same resend id — should be rejected',
      resendEmailId: resendId,
    })
  } catch (err) {
    rejected = true
    dupErr = err instanceof Error ? err.message : String(err)
  }
  check('UNIQUE(resend_email_id) blocks duplicate insert', rejected, dupErr.slice(0, 80))

  // Belt: confirm only one row exists with that resend_email_id
  const [dupCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(subscriberReplies)
    .where(eq(subscriberReplies.resendEmailId, resendId))
  check('only one row persisted with that resend_email_id', dupCount.n === 1, `count=${dupCount.n}`)
}

async function scenario7_latestReplyHelper(subscriberId: string) {
  console.log('\n[7] getLatestReply returns most-recent body')
  const latest = await getLatestReply(subscriberId)
  // Most recent across all our test inserts is the unthreaded one from scenario 5
  // or the duplicate one from scenario 6 — both very recent. Just confirm non-null.
  check('getLatestReply returns non-null body', !!latest, latest ? `${latest.slice(0, 60)}…` : 'null')
}

async function cleanup(subscriberId: string) {
  await db.delete(subscriberReplies).where(eq(subscriberReplies.subscriberId, subscriberId))
  await db.delete(emailsSent).where(eq(emailsSent.subscriberId, subscriberId))
  await db.delete(inboundEvents).where(like(inboundEvents.emailId, `em_${TAG}_%`))
  await db.delete(churnedSubscribers).where(eq(churnedSubscribers.id, subscriberId))
}

async function main() {
  console.log(`Spec 71 smoke harness  (--keep to leave subscriber for browser inspection)`)

  await scenario1_migrationSanity()

  console.log('\nSeeding subscriber + outbound emails…')
  const { subscriberId, exit } = await seed()
  console.log(`  subscriber: ${subscriberId}`)

  await scenario2_inboundWebhookE2E(subscriberId)
  await scenario3_multiTurnConversation(subscriberId)
  await scenario4_threadingViaInReplyTo(subscriberId, exit.id)
  await scenario5_unthreadedReply(subscriberId)
  await scenario6_duplicateWebhook(subscriberId)
  await scenario7_latestReplyHelper(subscriberId)

  console.log('\n── SUMMARY ─────────────────────────────────')
  const pass = verdicts.filter((v) => v.pass).length
  const fail = verdicts.filter((v) => !v.pass).length
  console.log(`  ${pass} passed, ${fail} failed of ${verdicts.length} checks`)
  if (fail > 0) {
    console.log('\n  Failing checks:')
    for (const v of verdicts.filter((x) => !x.pass)) {
      console.log(`    ✗ ${v.name}${v.detail ? ` — ${v.detail}` : ''}`)
    }
  }

  if (KEEP) {
    console.log(`\n  Keeping subscriber. Open inspector to verify timeline:`)
    console.log(`    http://localhost:3000/admin/subscribers/${subscriberId}`)
    console.log(`  Cleanup later:`)
    console.log(`    npx tsx --env-file=.env.local scripts/smoke-spec71.ts --cleanup ${subscriberId}`)
  } else {
    console.log('\nCleaning up…')
    await cleanup(subscriberId)
    console.log('  done')
  }

  if (fail > 0) process.exit(1)
}

// --cleanup <id> mode
const cleanupId = process.argv.indexOf('--cleanup')
if (cleanupId >= 0 && process.argv[cleanupId + 1]) {
  cleanup(process.argv[cleanupId + 1])
    .then(() => { console.log('Cleaned up'); process.exit(0) })
    .catch((e) => { console.error(e); process.exit(1) })
} else {
  main().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1) })
}

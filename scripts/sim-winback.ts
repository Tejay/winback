/**
 * Visual simulation: seed cancellation win-back rows for tejaasvi@gmail.com
 * (dev DB only) so the Win-backs tab + drawer render with realistic data
 * for the redesign work — recovery likelihood, drawer insight, and inbound
 * replies (the "awaiting your reply" state).
 *
 * Safe by design:
 *   - DEV ONLY. Run with the dev env-file (see usage). Never point at prod.
 *   - Rows tagged with `cus_sim_wb_` stripeCustomerId prefix → idempotent.
 *   - An exit email row is inserted per subscriber; replied ones also get a
 *     wb_subscriber_replies row + repliedAt stamp so the conversation view
 *     and "awaiting reply" sort/badge light up. No outbound send happens.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/sim-winback.ts
 *   npx tsx --env-file=.env.local scripts/sim-winback.ts --clean
 */
import { eq, and, like } from 'drizzle-orm'
import { db } from '../lib/db'
import { users, customers, churnedSubscribers, emailsSent, subscriberReplies } from '../lib/schema'

const SIM_PREFIX = 'cus_sim_wb_'

type Seed = {
  name: string
  email: string
  planName: string
  mrrCents: number
  daysSinceCancel: number
  tenureDays: number
  reason: string
  category: string
  recovery: 'high' | 'medium' | 'low'
  read: string
  worthKnowing: string
  status: 'pending' | 'recovered'
  reply?: string // inbound reply body → makes it "awaiting your reply"
}

const SEEDS: Seed[] = [
  {
    name: 'Maria Gomez', email: 'maria.gomez@example.com', planName: 'Pro Monthly', mrrCents: 1999,
    daysSinceCancel: 7, tenureDays: 420, reason: 'Travelling for a few weeks, can’t keep my streak', category: 'Temporary',
    recovery: 'high',
    read: 'Paused because she’s travelling for 6 weeks and can’t keep her workout streak — a temporary life situation, not dissatisfaction with the app.',
    worthKnowing: 'Asked whether she can freeze her membership instead of cancelling. Very likely to return if offered a pause.',
    status: 'pending',
    reply: 'Honestly I love the app, I’m just away for six weeks and didn’t want to pay while I can’t use it. Is there a way to pause instead?',
  },
  {
    name: 'Devon Park', email: 'devon.park@example.com', planName: 'Pro Monthly', mrrCents: 1999,
    daysSinceCancel: 5, tenureDays: 90, reason: 'Switching to an app with live classes', category: 'Competitor',
    recovery: 'medium',
    read: 'Left for a competitor that offers live classes; felt our on-demand library had gone stale for him.',
    worthKnowing: 'Open to returning if we add live sessions, but it’s not urgent for him.',
    status: 'pending',
    reply: 'Moved my routine over to a service with live coached classes. The on-demand stuff here started feeling repetitive.',
  },
  {
    name: 'Priya Nair', email: 'priya.nair@example.com', planName: 'Pro Monthly', mrrCents: 1999,
    daysSinceCancel: 3, tenureDays: 210, reason: 'Price jumped after the intro period', category: 'Price',
    recovery: 'high',
    read: 'Cancelled right after a billing date — the Pro price jumped more than she expected once the intro period ended.',
    worthKnowing: 'Price-sensitive but used the app daily until cancelling. A small loyalty discount would likely win her back.',
    status: 'pending',
  },
  {
    name: 'Lena Fischer', email: 'lena.fischer@example.com', planName: 'Starter Monthly', mrrCents: 999,
    daysSinceCancel: 18, tenureDays: 540, reason: 'Missing Apple Watch sync', category: 'Missing feature',
    recovery: 'low',
    read: 'Briefly cancelled over a missing Apple Watch sync; came back once it shipped.',
    worthKnowing: 'Power user, high lifetime value — already recovered.',
    status: 'recovered',
  },
]

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)
const rid = () => Math.random().toString(36).slice(2, 10)

async function main() {
  const clean = process.argv.includes('--clean')

  const [u] = await db.select().from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  if (!u) throw new Error('No user for tejaasvi@gmail.com in this DB')
  const [customer] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!customer) throw new Error('No customer for tejaasvi@gmail.com')

  // Idempotent cleanup (cascade handles replies/emails, but be explicit).
  const prior = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customer.id),
      like(churnedSubscribers.stripeCustomerId, `${SIM_PREFIX}%`),
    ))
  for (const p of prior) {
    await db.delete(subscriberReplies).where(eq(subscriberReplies.subscriberId, p.id))
    await db.delete(emailsSent).where(eq(emailsSent.subscriberId, p.id))
    await db.delete(churnedSubscribers).where(eq(churnedSubscribers.id, p.id))
  }
  console.log(`Cleaned ${prior.length} prior sim row(s).`)
  if (clean) { console.log('Done (--clean).'); process.exit(0) }

  for (const s of SEEDS) {
    const cancelledAt = daysAgo(s.daysSinceCancel)
    const exitSentAt = new Date(cancelledAt.getTime() + 60 * 60 * 1000) // +1h
    const replyAt = s.reply ? new Date(cancelledAt.getTime() + 24 * 60 * 60 * 1000) : null // +1d

    const [sub] = await db.insert(churnedSubscribers).values({
      customerId: customer.id,
      stripeCustomerId: `${SIM_PREFIX}${rid()}`,
      stripeSubscriptionId: `sub_sim_wb_${rid()}`,
      email: s.email,
      name: s.name,
      planName: s.planName,
      mrrCents: s.mrrCents,
      cancellationReason: s.reason,
      cancellationCategory: s.category,
      tier: s.recovery === 'high' ? 1 : 2,
      confidence: '0.88',
      status: s.status,
      source: 'webhook',
      cancelledAt,
      tenureDays: s.tenureDays,
      triggerNeed: s.worthKnowing,
      recoveryLikelihood: s.recovery,
      drawerInsightRead: s.read,
      drawerInsightWorthKnowing: s.worthKnowing,
      lastEngagementAt: replyAt,
      createdAt: cancelledAt,
    }).returning({ id: churnedSubscribers.id })

    // Outbound exit email (the listen-only opener). repliedAt set when a reply exists.
    const [exitEmail] = await db.insert(emailsSent).values({
      subscriberId: sub.id,
      type: 'exit',
      subject: `Sorry to see you go, ${s.name.split(' ')[0]}`,
      bodyText: `Hi ${s.name.split(' ')[0]},\n\nSorry to see you cancel ${customer.productName ?? 'your plan'}. Mind sharing what led to the decision? It genuinely helps us.\n\n— ${customer.founderName ?? 'The team'}`,
      sentAt: exitSentAt,
      repliedAt: replyAt,
      gmailMessageId: `sim_msg_${rid()}`,
    }).returning({ id: emailsSent.id })

    if (s.reply && replyAt) {
      await db.insert(subscriberReplies).values({
        subscriberId: sub.id,
        body: s.reply,
        fromEmail: s.email,
        receivedAt: replyAt,
        inReplyToEmailId: exitEmail.id,
        resendEmailId: `sim_inbound_${rid()}`,
      })
    }

    console.log(`+ ${s.name.padEnd(13)} recovery=${s.recovery.padEnd(6)} ${s.reply ? 'REPLIED ' : 'no-reply'} status=${s.status.padEnd(9)} → ${sub.id}`)
  }

  console.log(`\nSeeded ${SEEDS.length} win-back rows for customer ${customer.id} (${customer.productName}).`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })

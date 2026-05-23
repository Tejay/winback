/**
 * Visual simulation: seed a few payment-recovery rows for tejaasvi@gmail.com
 * (dev DB only) so the Payment recoveries tab renders with realistic data.
 *
 * Safe by design:
 *   - DEV ONLY. Run with the dev env-file (see usage). Never point this at prod.
 *   - Rows are tagged with a `cus_sim_pr_` stripeCustomerId prefix so re-runs
 *     are idempotent (prior sim rows + their emails are deleted first).
 *   - A matching wb_emails_sent `dunning` row is inserted per subscriber, so the
 *     production (subscriber_id, type) dedupe guard prevents any resend even if
 *     a cron fired. Local crons don't auto-run anyway.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/sim-payment-recovery.ts
 *   npx tsx --env-file=.env.local scripts/sim-payment-recovery.ts --clean   # remove sim rows only
 */
import { eq, and, like } from 'drizzle-orm'
import { db } from '../lib/db'
import { users, customers, churnedSubscribers, emailsSent } from '../lib/schema'

const SIM_PREFIX = 'cus_sim_pr_'

type Seed = {
  name: string
  email: string
  planName: string
  mrrCents: number
  daysSinceFailed: number
  state: 'awaiting_retry' | 'final_retry_pending' | 'recovered_during_dunning'
  touchCount: number
  declineCode: string
  recovered?: boolean
}

const SEEDS: Seed[] = [
  // In retry (T1)
  { name: 'Marcus Hale',   email: 'marcus.hale@example.com',  planName: 'Pro Monthly',     mrrCents: 1999, daysSinceFailed: 1, state: 'awaiting_retry',       touchCount: 1, declineCode: 'insufficient_funds' },
  // On final retry (T3)
  { name: 'Priya Anand',   email: 'priya.anand@example.com',  planName: 'Pro Monthly',     mrrCents: 1999, daysSinceFailed: 5, state: 'final_retry_pending',  touchCount: 3, declineCode: 'expired_card' },
  // Recovered during dunning (the win column)
  { name: 'Dani Rivera',   email: 'dani.rivera@example.com',  planName: 'Starter Monthly', mrrCents: 999,  daysSinceFailed: 3, state: 'recovered_during_dunning', touchCount: 2, declineCode: 'do_not_honor', recovered: true },
]

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000)
const rid = () => Math.random().toString(36).slice(2, 10)

async function main() {
  const clean = process.argv.includes('--clean')

  const [u] = await db.select().from(users).where(eq(users.email, 'tejaasvi@gmail.com')).limit(1)
  if (!u) throw new Error('No user for tejaasvi@gmail.com in this DB')
  const [customer] = await db.select().from(customers).where(eq(customers.userId, u.id)).limit(1)
  if (!customer) throw new Error('No customer for tejaasvi@gmail.com')

  // Idempotent cleanup: drop prior sim rows (+ their emails) for this customer.
  const prior = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customer.id),
      like(churnedSubscribers.stripeCustomerId, `${SIM_PREFIX}%`),
    ))
  for (const p of prior) {
    await db.delete(emailsSent).where(eq(emailsSent.subscriberId, p.id))
    await db.delete(churnedSubscribers).where(eq(churnedSubscribers.id, p.id))
  }
  console.log(`Cleaned ${prior.length} prior sim row(s).`)
  if (clean) { console.log('Done (--clean).'); process.exit(0) }

  for (const s of SEEDS) {
    const failedAt = daysAgo(s.daysSinceFailed)
    const nextRetry =
      s.state === 'awaiting_retry' || s.state === 'final_retry_pending'
        ? daysAgo(-1 - Math.random() * 1.5) // ~1–2 days in the future
        : null

    const [sub] = await db.insert(churnedSubscribers).values({
      customerId: customer.id,
      stripeCustomerId: `${SIM_PREFIX}${rid()}`,
      stripeSubscriptionId: `sub_sim_pr_${rid()}`,
      email: s.email,
      name: s.name,
      planName: s.planName,
      mrrCents: s.mrrCents,
      cancellationReason: 'Payment failed',
      cancellationCategory: 'Other',
      tier: 2,
      confidence: '0.90',
      status: s.recovered ? 'recovered' : 'pending',
      source: 'webhook',
      paymentMethodAtFailure: `pm_sim_${rid()}`,
      nextPaymentAttemptAt: nextRetry,
      dunningTouchCount: s.touchCount,
      dunningLastTouchAt: new Date(failedAt.getTime() + 30 * 60 * 1000),
      dunningState: s.state,
      lastDeclineCode: s.declineCode,
      createdAt: failedAt,
    }).returning({ id: churnedSubscribers.id })

    // Dedupe-guard email row (prevents any resend; matches seed-demo pattern).
    await db.insert(emailsSent).values({
      subscriberId: sub.id,
      type: 'dunning',
      subject: "Your payment didn't go through",
      bodyText: `Hi ${s.name.split(' ')[0]},\n\nWe couldn't process your latest payment for ${s.planName} (${s.declineCode}). Update your card to keep things running.\n\n— ${customer.founderName ?? 'The team'}`,
      sentAt: new Date(failedAt.getTime() + 60 * 1000),
    })

    console.log(`+ ${s.name.padEnd(14)} ${s.state.padEnd(24)} touch=${s.touchCount} ${s.declineCode} $${(s.mrrCents / 100).toFixed(2)} → ${sub.id}`)
  }

  console.log(`\nSeeded ${SEEDS.length} payment-recovery rows for customer ${customer.id} (${customer.productName}).`)
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })

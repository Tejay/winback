import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { and, eq, isNotNull, isNull, lt, or, count, sql } from 'drizzle-orm'
import {
  sendBillingNudgeDay7Email,
  sendBillingNudgeDay30Email,
  sendBillingMonthlyReportEmail,
} from '@/src/winback/lib/billing-notifications'
import { logEvent } from '@/src/winback/lib/events'
import { withCron } from '@/src/winback/lib/cron-wrap'

export const maxDuration = 60

/**
 * Spec 51 — billing-nudge cron.
 *
 * Daily orchestration of three passes for customers in the post-trial
 * billing-pause state (activatedAt set + no stripeSubscriptionId):
 *
 *   1. Day-7 nudge   — sent once, ~7 days after activatedAt
 *   2. Day-30 nudge  — sent once, ~30 days after activatedAt
 *   3. Monthly report — sent every ~28 days after the day-30 nudge
 *
 * All passes share idempotency guards:
 *   - day-7 / day-30: single-fire via billingNudgeDay{7,30}SentAt
 *   - monthly: cadence-based via billingMonthlyReportLastSentAt
 *
 * Customers with billingEmailsOptedOutAt set are excluded from all passes.
 * Customers without stripeAccessToken (disconnected) are also excluded.
 *
 * Schedule: daily at 10:00 UTC via vercel.json (offset from other crons).
 *
 * Auth: Bearer ${CRON_SECRET} via withCron (Spec 69).
 *
 * `?dryRun=1` skips sends, returns counts only.
 */
export const GET = (req: NextRequest) => withCron('billing-nudge', req, async () => {
  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'
  const now = Date.now()
  const day7Cutoff = new Date(now - 7 * 24 * 60 * 60 * 1000)
  const day30Cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000)
  const monthlyCutoff = new Date(now - 28 * 24 * 60 * 60 * 1000)

  // Common filter for "is currently in post-trial paused state and eligible
  // for billing nudges" — used by all three passes.
  const eligibleBase = and(
    isNotNull(customers.activatedAt),
    isNull(customers.stripeSubscriptionId),
    isNotNull(customers.stripeAccessToken),
    isNull(customers.billingEmailsOptedOutAt),
  )

  // ── Pass 1: Day-7 nudge ────────────────────────────────────────────────
  const day7Targets = await db
    .select({ id: customers.id, activatedAt: customers.activatedAt })
    .from(customers)
    .where(
      and(
        eligibleBase,
        isNull(customers.billingNudgeDay7SentAt),
        lt(customers.activatedAt, day7Cutoff),
      ),
    )

  let day7Sent = 0
  for (const c of day7Targets) {
    if (!dryRun) {
      const [counts] = await db
        .select({
          cancellations: count(churnedSubscribers.id),
        })
        .from(churnedSubscribers)
        .where(
          and(
            eq(churnedSubscribers.customerId, c.id),
            sql`${churnedSubscribers.cancelledAt} > ${c.activatedAt}`,
          ),
        )
      // Failed payments share the same table; cancelledAt is null on those
      // rows, but createdAt anchors them. Count them separately.
      const [failedPayments] = await db
        .select({ failed: count(churnedSubscribers.id) })
        .from(churnedSubscribers)
        .where(
          and(
            eq(churnedSubscribers.customerId, c.id),
            isNotNull(churnedSubscribers.dunningState),
            sql`${churnedSubscribers.createdAt} > ${c.activatedAt}`,
          ),
        )
      await sendBillingNudgeDay7Email({
        customerId: c.id,
        cancellationsSincePauseCount: counts?.cancellations ?? 0,
        failedPaymentsSincePauseCount: failedPayments?.failed ?? 0,
      })
      await db
        .update(customers)
        .set({ billingNudgeDay7SentAt: new Date() })
        .where(eq(customers.id, c.id))
      await logEvent({
        name: 'billing_nudge_sent',
        customerId: c.id,
        properties: { day: 7 },
      })
    }
    day7Sent++
  }

  // ── Pass 2: Day-30 nudge ───────────────────────────────────────────────
  const day30Targets = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eligibleBase,
        isNull(customers.billingNudgeDay30SentAt),
        lt(customers.activatedAt, day30Cutoff),
      ),
    )

  let day30Sent = 0
  for (const c of day30Targets) {
    if (!dryRun) {
      await sendBillingNudgeDay30Email({ customerId: c.id })
      await db
        .update(customers)
        .set({ billingNudgeDay30SentAt: new Date() })
        .where(eq(customers.id, c.id))
      await logEvent({
        name: 'billing_nudge_sent',
        customerId: c.id,
        properties: { day: 30 },
      })
    }
    day30Sent++
  }

  // ── Pass 3: Monthly report (after day-30) ──────────────────────────────
  // Eligible when: day-30 nudge already sent AND either monthly never sent
  // (and day-30 nudge was ≥28 days ago) OR last monthly was ≥28 days ago.
  const monthlyTargets = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eligibleBase,
        isNotNull(customers.billingNudgeDay30SentAt),
        or(
          and(
            isNull(customers.billingMonthlyReportLastSentAt),
            lt(customers.billingNudgeDay30SentAt, monthlyCutoff),
          ),
          and(
            isNotNull(customers.billingMonthlyReportLastSentAt),
            lt(customers.billingMonthlyReportLastSentAt, monthlyCutoff),
          ),
        ),
      ),
    )

  const monthLabel = new Date().toLocaleString('en-US', { month: 'long' })

  let monthlySent = 0
  for (const c of monthlyTargets) {
    if (!dryRun) {
      // Last 30 days of activity, counted for the report
      const since = new Date(now - 30 * 24 * 60 * 60 * 1000)
      const [cancellations] = await db
        .select({ n: count(churnedSubscribers.id) })
        .from(churnedSubscribers)
        .where(
          and(
            eq(churnedSubscribers.customerId, c.id),
            sql`${churnedSubscribers.cancelledAt} > ${since}`,
          ),
        )
      const [failedPayments] = await db
        .select({ n: count(churnedSubscribers.id) })
        .from(churnedSubscribers)
        .where(
          and(
            eq(churnedSubscribers.customerId, c.id),
            isNotNull(churnedSubscribers.dunningState),
            sql`${churnedSubscribers.createdAt} > ${since}`,
          ),
        )
      const [recoverable] = await db
        .select({
          n: count(churnedSubscribers.id),
          mrr: sql<number>`COALESCE(SUM(${churnedSubscribers.mrrCents}), 0)`,
        })
        .from(churnedSubscribers)
        .where(
          and(
            eq(churnedSubscribers.customerId, c.id),
            sql`${churnedSubscribers.recoveryLikelihood} IN ('high', 'medium')`,
            sql`${churnedSubscribers.status} != 'recovered'`,
          ),
        )

      await sendBillingMonthlyReportEmail({
        customerId: c.id,
        monthLabel,
        cancellationsCount: cancellations?.n ?? 0,
        failedPaymentsCount: failedPayments?.n ?? 0,
        recoverableCount: recoverable?.n ?? 0,
        recoverableMrrAnnualizedCents: (recoverable?.mrr ?? 0) * 12,
      })
      await db
        .update(customers)
        .set({ billingMonthlyReportLastSentAt: new Date() })
        .where(eq(customers.id, c.id))
      await logEvent({
        name: 'billing_nudge_sent',
        customerId: c.id,
        properties: { day: 'monthly' },
      })
    }
    monthlySent++
  }

  return {
    dryRun,
    day7: day7Sent,
    day30: day30Sent,
    monthly: monthlySent,
  }
})

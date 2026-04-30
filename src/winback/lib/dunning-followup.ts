/**
 * Spec 33 — Multi-touch dunning cron helpers.
 *
 * Two independent passes called by /api/cron/dunning-followup:
 *   - T2 (24h before Stripe's retry #2):
 *       dunning_state='awaiting_retry' AND dunning_touch_count=1
 *   - T3 (24h before final retry):
 *       dunning_state='final_retry_pending' AND dunning_touch_count=2
 *
 * The eligibility window is generous (12-36h before next_payment_attempt_at)
 * so a missed daily run is picked up on the next tick. Per-row try/catch,
 * idempotent at the email layer via the partial unique index on
 * wb_emails_sent (subscriber_id, type) — see migration 028.
 */
import { db } from '@/lib/db'
import { churnedSubscribers, customers, users } from '@/lib/schema'
import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { sendDunningFollowupEmail } from './email'
import { logEvent } from './events'

export type DunningRunResult = { processed: number; sent: number; errors: number }

const TOUCH_LIMIT = 100

interface EligibleRow {
  subscriberId:    string
  email:           string | null
  customerName:    string | null
  planName:        string | null
  mrrCents:        number
  retryDate:       Date
  customerId:      string
  founderName:     string | null
  productName:     string | null
  userName:        string | null
}

async function fetchEligible(opts: {
  dunningState: 'awaiting_retry' | 'final_retry_pending'
  touchCount:   number
}): Promise<EligibleRow[]> {
  const rows = await db
    .select({
      subscriberId:    churnedSubscribers.id,
      email:           churnedSubscribers.email,
      customerName:    churnedSubscribers.name,
      planName:        churnedSubscribers.planName,
      mrrCents:        churnedSubscribers.mrrCents,
      retryDate:       churnedSubscribers.nextPaymentAttemptAt,
      customerId:      customers.id,
      founderName:     customers.founderName,
      productName:     customers.productName,
      userName:        users.name,
    })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(customers.id, churnedSubscribers.customerId))
    .innerJoin(users, eq(users.id, customers.userId))
    .where(
      and(
        eq(churnedSubscribers.dunningState, opts.dunningState),
        eq(churnedSubscribers.dunningTouchCount, opts.touchCount),
        eq(churnedSubscribers.doNotContact, false),
        isNotNull(churnedSubscribers.nextPaymentAttemptAt),
        // 12-36h-before window — generous so a missed daily run gets it
        // on the next tick.
        sql`${churnedSubscribers.nextPaymentAttemptAt}
            BETWEEN now() + interval '12 hours'
                AND now() + interval '36 hours'`,
      ),
    )
    .limit(TOUCH_LIMIT)

  // Filter out null fields we can't safely send to (no email = skip).
  return rows
    .filter((r): r is EligibleRow => !!r.email && !!r.retryDate)
}

async function processOnePass(opts: {
  rows:         EligibleRow[]
  isFinalRetry: boolean
  newTouch:     2 | 3
  dryRun:       boolean
}): Promise<DunningRunResult> {
  const { rows, isFinalRetry, newTouch, dryRun } = opts
  let sent = 0
  let errors = 0

  for (const row of rows) {
    try {
      if (dryRun) {
        sent++
        continue
      }

      // Prefer product name so the subscriber sees the brand they signed up to.
      const fromName = row.productName ?? row.founderName ?? row.userName ?? 'The team'

      await sendDunningFollowupEmail({
        subscriberId: row.subscriberId,
        email:        row.email!,
        customerName: row.customerName,
        planName:     row.planName ?? 'Subscription',
        amountDue:    row.mrrCents,
        currency:     'usd',
        retryDate:    row.retryDate,
        fromName,
        isFinalRetry,
      })

      await db
        .update(churnedSubscribers)
        .set({
          dunningTouchCount: newTouch,
          dunningLastTouchAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(churnedSubscribers.id, row.subscriberId))

      await logEvent({
        name: 'dunning_touch_sent',
        customerId: row.customerId,
        properties: {
          subscriberId: row.subscriberId,
          touch: newTouch,
          isFinalRetry,
        },
      })

      sent++
    } catch (err) {
      errors++
      console.error('[dunning-followup] error for', row.email, err)
    }
  }

  return { processed: rows.length, sent, errors }
}

/**
 * T2 + T3 in one pass. Returns aggregated counts so the cron route can
 * surface them in its response body.
 */
export async function runDunningTouches(opts: {
  dryRun: boolean
}): Promise<{ t2: DunningRunResult; t3: DunningRunResult }> {
  const { dryRun } = opts

  const t2Rows = await fetchEligible({ dunningState: 'awaiting_retry',       touchCount: 1 })
  const t2 = await processOnePass({ rows: t2Rows, isFinalRetry: false, newTouch: 2, dryRun })

  const t3Rows = await fetchEligible({ dunningState: 'final_retry_pending', touchCount: 2 })
  const t3 = await processOnePass({ rows: t3Rows, isFinalRetry: true,  newTouch: 3, dryRun })

  return { t2, t3 }
}

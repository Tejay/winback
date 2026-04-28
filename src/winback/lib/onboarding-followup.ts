/**
 * Spec 30 — Onboarding follow-up cron helpers.
 *
 * Three independent passes that the daily cron route delegates to:
 *   - runOnboardingNudges:    Day-3 nudge to dormant founders
 *   - runDeletionWarnings:    Day-83 "we'll delete in 7 days" courtesy
 *   - runStaleAccountPrune:   Day-90 cascade-delete of the user row
 *
 * Each pass is independently testable, idempotent, per-row try/catch,
 * and respects ?dryRun=1.
 */
import { db } from '@/lib/db'
import { customers, users, recoveries } from '@/lib/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  sendOnboardingNudgeEmail,
  sendDormantAccountDeletionWarningEmail,
} from './email'
import { logEvent } from './events'

export type RunResult = { processed: number; sent: number; errors: number }
export type PruneResult = { processed: number; deleted: number; errors: number }

const NUDGE_LIMIT = 100
const WARNING_LIMIT = 100
const PRUNE_LIMIT = 50

/**
 * Pass A — Day-3 nudge. Selects dormant founders 3-89 days old who haven't
 * been nudged yet. Per-row: re-check stripe is still null, send email,
 * mark `onboarding_nudge_sent_at`, log event. Errors caught per row.
 */
export async function runOnboardingNudges(opts: {
  dryRun: boolean
}): Promise<RunResult> {
  const { dryRun } = opts

  const rows = await db
    .select({
      customerId:  customers.id,
      userId:      users.id,
      email:       users.email,
      founderName: customers.founderName,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(
      and(
        isNull(customers.stripeAccountId),
        isNull(customers.onboardingNudgeSentAt),
        eq(users.isAdmin, false),
        sql`${customers.createdAt} <= now() - interval '3 days'`,
        sql`${customers.createdAt} >  now() - interval '90 days'`,
      ),
    )
    .limit(NUDGE_LIMIT)

  let sent = 0
  let errors = 0

  for (const row of rows) {
    try {
      // Race guard: re-fetch the customer's stripe state right before the send.
      const [fresh] = await db
        .select({ stripeAccountId: customers.stripeAccountId })
        .from(customers)
        .where(eq(customers.id, row.customerId))
        .limit(1)
      if (fresh?.stripeAccountId) continue

      if (dryRun) {
        sent++
        continue
      }

      await sendOnboardingNudgeEmail({
        to:          row.email,
        founderName: row.founderName,
      })

      await db
        .update(customers)
        .set({ onboardingNudgeSentAt: new Date() })
        .where(eq(customers.id, row.customerId))

      await logEvent({
        name:       'onboarding_nudge_sent',
        customerId: row.customerId,
        userId:     row.userId,
        properties: {},
      })

      sent++
    } catch (err) {
      errors++
      console.error('[onboarding-followup] nudge error for', row.email, err)
    }
  }

  return { processed: rows.length, sent, errors }
}

/**
 * Pass B — Day-83 deletion warning. Fires once for the 7-day window before
 * auto-prune. Same shape as Pass A.
 */
export async function runDeletionWarnings(opts: {
  dryRun: boolean
}): Promise<RunResult> {
  const { dryRun } = opts

  const rows = await db
    .select({
      customerId:  customers.id,
      userId:      users.id,
      email:       users.email,
      founderName: customers.founderName,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(
      and(
        isNull(customers.stripeAccountId),
        isNull(customers.deletionWarningSentAt),
        eq(users.isAdmin, false),
        sql`${customers.createdAt} <= now() - interval '83 days'`,
        sql`${customers.createdAt} >  now() - interval '90 days'`,
      ),
    )
    .limit(WARNING_LIMIT)

  let sent = 0
  let errors = 0

  for (const row of rows) {
    try {
      const [fresh] = await db
        .select({ stripeAccountId: customers.stripeAccountId })
        .from(customers)
        .where(eq(customers.id, row.customerId))
        .limit(1)
      if (fresh?.stripeAccountId) continue

      if (dryRun) {
        sent++
        continue
      }

      await sendDormantAccountDeletionWarningEmail({
        to:          row.email,
        founderName: row.founderName,
      })

      await db
        .update(customers)
        .set({ deletionWarningSentAt: new Date() })
        .where(eq(customers.id, row.customerId))

      await logEvent({
        name:       'onboarding_deletion_warning_sent',
        customerId: row.customerId,
        userId:     row.userId,
        properties: {},
      })

      sent++
    } catch (err) {
      errors++
      console.error('[onboarding-followup] warning error for', row.email, err)
    }
  }

  return { processed: rows.length, sent, errors }
}

/**
 * Pass C — Day-90 cascade prune. Deletes wb_users for accounts that are
 * 90+ days old, never connected Stripe, never had a recovery, and aren't
 * internal admins. Audit event written FIRST with `customerId: null` so
 * the row survives the cascade (events.customerId has onDelete:cascade,
 * events.userId has onDelete:set null — see lib/schema.ts).
 */
export async function runStaleAccountPrune(opts: {
  dryRun: boolean
}): Promise<PruneResult> {
  const { dryRun } = opts

  const rows = await db
    .select({
      customerId:  customers.id,
      userId:      users.id,
      email:       users.email,
      founderName: customers.founderName,
      createdAt:   customers.createdAt,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(
      and(
        isNull(customers.stripeAccountId),
        eq(users.isAdmin, false),
        sql`${customers.createdAt} <= now() - interval '90 days'`,
        sql`NOT EXISTS (SELECT 1 FROM ${recoveries} WHERE ${recoveries.customerId} = ${customers.id})`,
      ),
    )
    .limit(PRUNE_LIMIT)

  let deleted = 0
  let errors = 0

  for (const row of rows) {
    try {
      const daysOld = row.createdAt
        ? Math.floor((Date.now() - row.createdAt.getTime()) / (1000 * 60 * 60 * 24))
        : null

      // Audit FIRST so the event row survives the upcoming cascade
      // (customerId:null, userId set-null on cascade — both protect the
      // event from being deleted with the user).
      await logEvent({
        name:       'onboarding_account_pruned',
        customerId: null,
        userId:     row.userId,
        properties: {
          email:       row.email,
          founderName: row.founderName,
          customerId:  row.customerId,
          daysOld,
          dryRun,
        },
      })

      if (dryRun) {
        deleted++
        continue
      }

      await db.delete(users).where(eq(users.id, row.userId))
      deleted++
    } catch (err) {
      errors++
      console.error('[onboarding-followup] prune error for', row.email, err)
    }
  }

  return { processed: rows.length, deleted, errors }
}

import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and, isNull, or, sql } from 'drizzle-orm'
import { decrypt } from './encryption'
import { extractSignals, getConnectStripe } from './stripe'
import { logEvent } from './events'

/**
 * Spec 72 — producer-side of the producer/consumer pipeline.
 *
 * Ingest is now a series of one-page-per-tick calls instead of one
 * synchronous loop. Each tick:
 *   1. Atomically claims the customer (lock prevents concurrent ticks)
 *   2. Pulls the next page from Stripe (using backfill_cursor as starting_after)
 *   3. INSERTs raw rows with classified_at = NULL — no LLM in the hot path
 *   4. Updates cursor or marks completed; releases lock
 *
 * Both the OAuth callback's fire-and-forget AND the backfill-ingest cron
 * call this same function. Idempotent end-to-end:
 *   - The atomic claim prevents two ticks from running concurrently
 *   - The UNIQUE (customer_id, stripe_customer_id) index + ON CONFLICT
 *     DO NOTHING tolerates any double-insert that does slip through
 *   - Stale-lock recovery (10 min) handles Vercel timeouts cleanly
 *
 * Completion signal is Stripe's `has_more: false`. Not row counts.
 */

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000
const PAGE_LIMIT = 100
const STALE_LOCK_MS = 10 * 60 * 1000

export type TickResult =
  | { kind: 'skipped';   reason: 'no_token' | 'claim_failed' | 'completed' }
  | { kind: 'progress';  rowsThisTick: number; cursorAdvancedTo: string }
  | { kind: 'completed'; rowsThisTick: number }
  | { kind: 'error';     errorMessage: string }

/**
 * Run one ingest tick for a single customer. Returns immediately if the
 * customer's backfill is already done or another tick holds the lock.
 */
export async function runBackfillIngestTick(customerId: string): Promise<TickResult> {
  // 1. Atomic claim. The WHERE clause excludes completed rows and
  // locked rows whose lock is still fresh (< 10 min). This serialises
  // concurrent ticks without taking a DB-level lock.
  const claimed = await db
    .update(customers)
    .set({ backfillProcessingAt: new Date() })
    .where(and(
      eq(customers.id, customerId),
      isNull(customers.backfillCompletedAt),
      or(
        isNull(customers.backfillProcessingAt),
        sql`${customers.backfillProcessingAt} < NOW() - INTERVAL '${sql.raw(String(STALE_LOCK_MS / 1000))} seconds'`,
      ),
    ))
    .returning({
      backfillCursor: customers.backfillCursor,
      stripeAccessToken: customers.stripeAccessToken,
      backfillProcessed: customers.backfillProcessed,
    })

  if (claimed.length === 0) {
    return { kind: 'skipped', reason: 'claim_failed' }
  }
  const row = claimed[0]
  if (!row.stripeAccessToken) {
    // No token (customer disconnected); release lock and exit.
    await db
      .update(customers)
      .set({ backfillProcessingAt: null })
      .where(eq(customers.id, customerId))
    return { kind: 'skipped', reason: 'no_token' }
  }

  try {
    const stripe = getConnectStripe(decrypt(row.stripeAccessToken))
    const oneYearAgo = new Date(Date.now() - ONE_YEAR_MS)

    const params: Stripe.SubscriptionListParams = {
      status: 'canceled',
      limit: PAGE_LIMIT,
      expand: ['data.customer'],
    }
    if (row.backfillCursor) params.starting_after = row.backfillCursor

    const page = await stripe.subscriptions.list(params)

    // 2. Insert each subscription as a raw row (classified_at = NULL).
    // Stop accumulating once we hit a sub older than 1 year — those are
    // outside our intake window. We still advance the cursor through them
    // so the next page is pulled.
    let insertedThisTick = 0
    let hitOldWall = false
    for (const sub of page.data) {
      const cancelledAt = sub.canceled_at ? new Date(sub.canceled_at * 1000) : null
      if (cancelledAt && cancelledAt < oneYearAgo) {
        hitOldWall = true
        break
      }

      const signals = await extractSignals(sub, decrypt(row.stripeAccessToken))

      // ON CONFLICT DO NOTHING is the second-layer dedup; the compound
      // UNIQUE index (customer_id, stripe_customer_id) catches duplicates
      // even when a webhook races us for the same row.
      const inserted = await db
        .insert(churnedSubscribers)
        .values({
          customerId,
          stripeCustomerId: signals.stripeCustomerId,
          stripeSubscriptionId: signals.stripeSubscriptionId,
          stripePriceId: signals.stripePriceId,
          email: signals.email,
          name: signals.name,
          planName: signals.planName,
          mrrCents: signals.mrrCents,
          tenureDays: signals.tenureDays,
          everUpgraded: signals.everUpgraded,
          nearRenewal: signals.nearRenewal,
          paymentFailures: signals.paymentFailures,
          previousSubs: signals.previousSubs,
          stripeEnum: signals.stripeEnum,
          stripeComment: signals.stripeComment,
          cancelledAt: signals.cancelledAt,
          source: 'backfill',
          status: 'pending',
          // classified_at intentionally NULL — classifier cron handles it
        })
        .onConflictDoNothing()
        .returning({ id: churnedSubscribers.id })

      if (inserted.length > 0) {
        insertedThisTick++
        await logEvent({
          name: 'backfill_row_inserted',
          customerId,
          properties: { subscriberId: inserted[0].id, source: 'backfill' },
        })
      }
    }

    // 3. Determine completion + update cursor + release lock atomically.
    const lastSubInPage = page.data[page.data.length - 1]
    const shouldComplete = !page.has_more || hitOldWall || page.data.length === 0
    const nextCursor = lastSubInPage?.id ?? row.backfillCursor ?? null
    const totalProcessed = (row.backfillProcessed ?? 0) + insertedThisTick

    if (shouldComplete) {
      await db
        .update(customers)
        .set({
          backfillCompletedAt: new Date(),
          backfillProcessingAt: null,
          backfillProcessed: totalProcessed,
        })
        .where(eq(customers.id, customerId))
      return { kind: 'completed', rowsThisTick: insertedThisTick }
    }

    await db
      .update(customers)
      .set({
        backfillCursor: nextCursor,
        backfillProcessingAt: null,
        backfillProcessed: totalProcessed,
      })
      .where(eq(customers.id, customerId))

    return {
      kind: 'progress',
      rowsThisTick: insertedThisTick,
      cursorAdvancedTo: nextCursor ?? '',
    }
  } catch (err) {
    // Release lock on error so the next tick can retry.
    await db
      .update(customers)
      .set({ backfillProcessingAt: null })
      .where(eq(customers.id, customerId))
    const message = err instanceof Error ? err.message : String(err)
    await logEvent({
      name: 'backfill_failed',
      customerId,
      properties: { errorMessage: message },
    })
    return { kind: 'error', errorMessage: message }
  }
}

/**
 * Convenience wrapper for the OAuth callback's fire-and-forget. Runs up
 * to `maxTicks` ingest ticks in-process so the merchant sees rows
 * appear quickly. The cron picks up anything past that.
 */
export async function runInitialBackfillBurst(
  customerId: string,
  maxTicks = 2,
): Promise<void> {
  // Mark started if it isn't already
  await db
    .update(customers)
    .set({ backfillStartedAt: sql`COALESCE(${customers.backfillStartedAt}, NOW())` })
    .where(eq(customers.id, customerId))

  for (let i = 0; i < maxTicks; i++) {
    const result = await runBackfillIngestTick(customerId)
    if (result.kind === 'completed' || result.kind === 'skipped' || result.kind === 'error') {
      return
    }
  }
}

/**
 * Clear all backfill bookkeeping for a customer.
 *
 * Why this exists: when a merchant disconnects + reconnects Stripe (or
 * switches Stripe accounts), the OAuth callback correctly identifies the
 * reconnect as `needsBackfill = true` and fires `/api/backfill/start`.
 * But `runBackfillIngestTick`'s atomic-claim WHERE clause includes
 * `isNull(backfillCompletedAt)` — so if a previous backfill ever
 * completed, the claim silently fails and `runInitialBackfillBurst`
 * bails after the first tick returns `{ kind: 'skipped', reason:
 * 'claim_failed' }`. The endpoint returns `success: true` because
 * nothing threw, but no rows are ingested.
 *
 * Net result before this helper existed: a merchant who reconnects
 * after a previous successful backfill ends up with an empty dashboard
 * and no error surfaced. Found 2026-05-18 on the demo workspace.
 *
 * Fix: the OAuth callback must reset these columns before triggering
 * the burst whenever `needsBackfill = true` so the atomic claim can
 * succeed against the row.
 *
 * Important caveat: this function does NOT touch existing
 * wb_churned_subscribers rows. On an account-changed reconnect those
 * rows are stale (they belong to the previous stripe_account_id) but
 * deletion is the caller's responsibility — it's a data-retention
 * decision worth flagging rather than burying inside a reset helper.
 */
export async function resetBackfillState(customerId: string): Promise<void> {
  await db
    .update(customers)
    .set({
      backfillStartedAt:    null,
      backfillCompletedAt:  null,
      backfillTotal:        0,
      backfillProcessed:    0,
      backfillCursor:       null,
      backfillProcessingAt: null,
    })
    .where(eq(customers.id, customerId))
}

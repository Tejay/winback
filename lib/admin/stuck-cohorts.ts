/**
 * Stuck-cohorts panel data for /admin (Now).
 *
 * Point-in-time worklist signals — "how many right now?" — for the
 * six cohorts the operator most often acts on. Each query is small,
 * uses existing indexes, and runs in parallel with the rest of the
 * rollup. Designed to be cheap enough to call on every 30s poll.
 *
 * Out of scope for v1: "webhook silent >24h", "pending email sends" —
 * deferred to a polish PR.
 */

import { and, eq, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import {
  churnedSubscribers,
  customers,
  wbEvents,
} from '../schema'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS  = 24 * HOUR_MS

/** Each tile in the Stuck cohorts panel. */
export interface StuckCohorts {
  /** Customers with 3+ oauth_error events in the last 24h — token likely revoked. */
  oauthIssues: number
  /** Subscribers stuck in classifier dead-letter (3+ failures). */
  classifierDeadLetter: number
  /** Activated customers with no sub on file (post-first-save paywall cohort). */
  paywallStuck: number
  /** Drain queue depth — subscribers waiting for their customer's pause-drain run. */
  drainPausedQueue: number
  /** Unclassified queue depth — subscribers awaiting classifier (attempts < 3). */
  unclassifiedQueue: number
  /** Customers whose backfill is in progress. */
  backfillInFlight: number
}

export async function buildStuckCohorts(): Promise<StuckCohorts> {
  const db = getDbReadOnly()
  const now = new Date()
  const twentyFourHoursAgo = new Date(Date.now() - DAY_MS)

  const [
    oauthIssues,
    classifierDeadLetter,
    paywallStuck,
    drainPausedQueue,
    unclassifiedQueue,
    backfillInFlight,
  ] = await Promise.all([
    // OAuth issues: distinct customer_ids with 3+ oauth_error events in 24h.
    // We don't try to detect "revoked" directly (no signal beyond the error
    // events); a customer with multiple oauth_errors in a day is the closest
    // proxy and matches what support needs to investigate.
    db
      .select({
        n: sql<number>`count(*)::int`,
      })
      .from(
        db
          .select({
            customerId: wbEvents.customerId,
          })
          .from(wbEvents)
          .where(and(
            eq(wbEvents.name, 'oauth_error'),
            gte(wbEvents.createdAt, twentyFourHoursAgo),
            isNotNull(wbEvents.customerId),
          ))
          .groupBy(wbEvents.customerId)
          .having(sql`count(*) >= 3`)
          .as('oauth_customers'),
      )
      .then((rows) => rows[0]?.n ?? 0),

    // Classifier dead-letter: subscribers with classify_attempts >= 3 and
    // still unclassified. Matches the existing dead-letter drawer query.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(churnedSubscribers)
      .where(and(
        isNull(churnedSubscribers.classifiedAt),
        sql`${churnedSubscribers.classifyAttempts} >= 3`,
      ))
      .then((rows) => rows[0]?.n ?? 0),

    // Paywall stuck: activated customer, no sub, not on active pilot.
    // Mirrors stuckAtPaywallNow() in rollups.ts so the count matches the
    // billing-health predicate exactly.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(and(
        isNotNull(customers.activatedAt),
        isNull(customers.stripeSubscriptionId),
        or(
          isNull(customers.pilotUntil),
          lt(customers.pilotUntil, now),
        ),
      ))
      .then((rows) => rows[0]?.n ?? 0),

    // Drain-paused queue: subscribers that haven't been drain-processed yet
    // for customers that ARE activated (i.e. drain should be running for
    // them). Matches the predicate in /api/cron/drain-paused-queue.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(churnedSubscribers)
      .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
      .where(and(
        isNull(churnedSubscribers.pauseDrainProcessedAt),
        isNotNull(customers.activatedAt),
      ))
      .then((rows) => rows[0]?.n ?? 0),

    // Unclassified queue: subscribers awaiting first classification (attempts
    // below the dead-letter threshold). This is the regular queue depth —
    // a healthy number here churns through every 2-min classifier run.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(churnedSubscribers)
      .where(and(
        isNull(churnedSubscribers.classifiedAt),
        sql`${churnedSubscribers.classifyAttempts} < 3`,
      ))
      .then((rows) => rows[0]?.n ?? 0),

    // Backfill in flight: customers with a backfill started but not yet
    // completed. Spec 72 producer — this number shrinks as the backfill
    // cron drains its queue.
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(and(
        isNotNull(customers.backfillStartedAt),
        isNull(customers.backfillCompletedAt),
      ))
      .then((rows) => rows[0]?.n ?? 0),
  ])

  return {
    oauthIssues,
    classifierDeadLetter,
    paywallStuck,
    drainPausedQueue,
    unclassifiedQueue,
    backfillInFlight,
  }
}

/**
 * Spec 25 — Cross-customer subscriber lookup. The single most-used query in
 * /admin/subscribers; drives the complaint-triage flow ("a subscriber emailed
 * support — find them across every Winback customer").
 *
 * Hits idx_churned_subscribers_email_ci (case-insensitive btree) added by
 * migration 018. Always uses the read-only DB connection.
 *
 * Every call is audit-logged via wb_events as 'admin_subscriber_lookup' so
 * support touches are visible in the event stream and Phase 3 audit-log UI.
 */

import { sql } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { churnedSubscribers, customers, users } from '../schema'
import { and, eq, desc, isNotNull, isNull } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

export interface AdminSubscriberRow {
  id: string
  customerId: string
  customerEmail: string | null
  customerProductName: string | null
  customerFounderName: string | null
  email: string | null
  name: string | null
  status: string
  cancelledAt: Date | null
  doNotContact: boolean | null
  founderHandoffAt: Date | null
  founderHandoffResolvedAt: Date | null
  aiPausedUntil: Date | null
  handoffReasoning: string | null
  recoveryLikelihood: string | null
  mrrCents: number
  cancellationReason: string | null
  cancellationCategory: string | null
}

export interface FindSubscribersByEmailOpts {
  /** Hard limit on rows returned. Default 100. */
  limit?: number
  /** The admin user performing the lookup, for the audit event. */
  adminUserId?: string
}

const SUBSCRIBER_SELECT = {
  id: churnedSubscribers.id,
  customerId: churnedSubscribers.customerId,
  customerEmail: users.email,
  customerProductName: customers.productName,
  customerFounderName: customers.founderName,
  email: churnedSubscribers.email,
  name: churnedSubscribers.name,
  status: churnedSubscribers.status,
  cancelledAt: churnedSubscribers.cancelledAt,
  doNotContact: churnedSubscribers.doNotContact,
  founderHandoffAt: churnedSubscribers.founderHandoffAt,
  founderHandoffResolvedAt: churnedSubscribers.founderHandoffResolvedAt,
  aiPausedUntil: churnedSubscribers.aiPausedUntil,
  handoffReasoning: churnedSubscribers.handoffReasoning,
  recoveryLikelihood: churnedSubscribers.recoveryLikelihood,
  mrrCents: churnedSubscribers.mrrCents,
  cancellationReason: churnedSubscribers.cancellationReason,
  cancellationCategory: churnedSubscribers.cancellationCategory,
}

/**
 * Look up every churned-subscriber row matching this email across all
 * Winback customers. Joins customers + users for display context. Logs an
 * `admin_subscriber_lookup` event so the search is auditable.
 */
export async function findSubscribersByEmail(
  email: string,
  opts: FindSubscribersByEmailOpts = {},
): Promise<AdminSubscriberRow[]> {
  const limit = opts.limit ?? 100
  const normalised = email.trim().toLowerCase()
  if (!normalised) return []

  const rows = await getDbReadOnly()
    .select(SUBSCRIBER_SELECT)
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .innerJoin(users, eq(customers.userId, users.id))
    .where(sql`lower(${churnedSubscribers.email}) = ${normalised}`)
    .orderBy(desc(churnedSubscribers.cancelledAt))
    .limit(limit)

  // Fire-and-forget audit event. Don't block the response if logEvent fails.
  void logEvent({
    name: 'admin_subscriber_lookup',
    userId: opts.adminUserId,
    properties: {
      email: normalised,
      resultCount: rows.length,
    },
  }).catch((err) => console.warn('admin_subscriber_lookup logEvent failed:', err))

  return rows.map((r) => ({
    ...r,
    status: r.status ?? 'pending',
  }))
}

/**
 * Spec 69 — return all subscribers belonging to one customer, newest first.
 * Powers the "View N subscribers" deep-link from the customer detail page.
 * Audit-logged like the email-based lookup.
 */
/**
 * PR 2 — Cohort lookup. Returns every subscriber in a named cohort that
 * matches one of the /admin Now stuck-cohort tiles, so the tile
 * click-through lands on the actual rows.
 *
 *   - drain_paused: pause_drain_processed_at IS NULL AND customer.activated_at IS NOT NULL
 *   - unclassified: classified_at IS NULL AND classify_attempts < 3
 *
 * Predicates mirror buildStuckCohorts() exactly so the count on the tile
 * matches the row count returned here.
 */
export type SubscriberCohort = 'drain_paused' | 'unclassified'

export async function findSubscribersByCohort(
  cohort: SubscriberCohort,
  opts: FindSubscribersByEmailOpts = {},
): Promise<AdminSubscriberRow[]> {
  const limit = opts.limit ?? 100

  const predicate = cohort === 'drain_paused'
    ? and(
        isNull(churnedSubscribers.pauseDrainProcessedAt),
        isNotNull(customers.activatedAt),
      )!
    : and(
        isNull(churnedSubscribers.classifiedAt),
        sql`${churnedSubscribers.classifyAttempts} < 3`,
      )!

  const rows = await getDbReadOnly()
    .select(SUBSCRIBER_SELECT)
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .innerJoin(users, eq(customers.userId, users.id))
    .where(predicate)
    .orderBy(desc(churnedSubscribers.cancelledAt))
    .limit(limit)

  void logEvent({
    name: 'admin_subscriber_lookup',
    userId: opts.adminUserId,
    properties: { cohort, resultCount: rows.length },
  }).catch((err) => console.warn('admin_subscriber_lookup logEvent failed:', err))

  return rows.map((r) => ({ ...r, status: r.status ?? 'pending' }))
}

export async function findSubscribersByCustomer(
  customerId: string,
  opts: FindSubscribersByEmailOpts = {},
): Promise<AdminSubscriberRow[]> {
  const limit = opts.limit ?? 100
  if (!customerId) return []

  const rows = await getDbReadOnly()
    .select(SUBSCRIBER_SELECT)
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(churnedSubscribers.customerId, customerId))
    .orderBy(desc(churnedSubscribers.cancelledAt))
    .limit(limit)

  void logEvent({
    name: 'admin_subscriber_lookup',
    userId: opts.adminUserId,
    properties: {
      customerId,
      resultCount: rows.length,
    },
  }).catch((err) => console.warn('admin_subscriber_lookup logEvent failed:', err))

  return rows.map((r) => ({
    ...r,
    status: r.status ?? 'pending',
  }))
}

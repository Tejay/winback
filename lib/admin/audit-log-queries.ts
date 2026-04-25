/**
 * Spec 27 — Audit Log queries.
 *
 * Pure presentation layer over wb_events filtered by name='admin_action'.
 * Decodes the JSONB `properties.action` field into structured columns so
 * the UI can render readable rows.
 */

import { sql, and, eq, gte, desc } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { wbEvents, customers, users } from '../schema'

export interface AuditLogRow {
  id: string
  createdAt: Date
  action: string                        // properties.action
  adminUserId: string | null
  adminEmail: string | null
  customerId: string | null
  customerEmail: string | null
  customerProductName: string | null
  /** Subject line — depends on action: subscriberId, runId, etc. */
  subject: string | null
  properties: Record<string, unknown>
}

/** All known action types — keep in sync with the admin mutation routes. */
export const KNOWN_ACTIONS = [
  'pause_customer',
  'force_oauth_reset',
  'resolve_open_handoffs',
  'unsubscribe_subscriber',
  'bulk_unsubscribe',
  'dsr_delete',
  'billing_retry',
  'classifier_re_run',
] as const

export type KnownAction = typeof KNOWN_ACTIONS[number]

/** Visual category — drives row colour in the audit-log UI. */
export const ACTION_CATEGORIES: Record<string, 'destructive' | 'state-change' | 'operational'> = {
  dsr_delete: 'destructive',
  force_oauth_reset: 'destructive',
  pause_customer: 'state-change',
  resolve_open_handoffs: 'state-change',
  unsubscribe_subscriber: 'state-change',
  bulk_unsubscribe: 'state-change',
  billing_retry: 'operational',
  classifier_re_run: 'operational',
}

const SINCE_INTERVALS: Record<string, string> = {
  '24h': '24 hours',
  '7d':  '7 days',
  '30d': '30 days',
  '90d': '90 days',
}

/**
 * Distinct admins who have performed actions in the last `since` window.
 * Powers the "admin user" filter dropdown.
 */
export async function listAuditAdmins(since = '90d'): Promise<Array<{ id: string; email: string }>> {
  const interval = SINCE_INTERVALS[since] ?? SINCE_INTERVALS['90d']
  const rows = await getDbReadOnly()
    .select({
      id: users.id,
      email: users.email,
    })
    .from(wbEvents)
    .innerJoin(users, eq(users.id, wbEvents.userId))
    .where(
      and(
        eq(wbEvents.name, 'admin_action'),
        sql`${wbEvents.createdAt} > now() - interval '${sql.raw(interval)}'`,
      ),
    )
    .groupBy(users.id, users.email)
  return rows
}

export interface AuditLogFilters {
  action?: string | null     // one of KNOWN_ACTIONS or null = all
  adminUserId?: string | null
  customerId?: string | null
  since?: string             // 24h | 7d | 30d | 90d (default 7d)
  limit?: number             // default 200, max 500
}

/**
 * Filtered, ordered audit-log rows. Always returns most-recent first.
 */
export async function queryAuditLog(filters: AuditLogFilters = {}): Promise<AuditLogRow[]> {
  const since = filters.since ?? '7d'
  const interval = SINCE_INTERVALS[since] ?? SINCE_INTERVALS['7d']
  const limit = Math.min(filters.limit ?? 200, 500)

  const conditions = [
    eq(wbEvents.name, 'admin_action'),
    sql`${wbEvents.createdAt} > now() - interval '${sql.raw(interval)}'`,
  ]

  if (filters.action) {
    conditions.push(sql`${wbEvents.properties}->>'action' = ${filters.action}`)
  }
  if (filters.adminUserId) {
    conditions.push(eq(wbEvents.userId, filters.adminUserId))
  }
  if (filters.customerId) {
    conditions.push(eq(wbEvents.customerId, filters.customerId))
  }

  const rows = await getDbReadOnly()
    .select({
      id: wbEvents.id,
      createdAt: wbEvents.createdAt,
      action: sql<string>`${wbEvents.properties}->>'action'`,
      adminUserId: wbEvents.userId,
      adminEmail: users.email,
      customerId: wbEvents.customerId,
      customerEmail: sql<string | null>`(select u.email from wb_users u join wb_customers c on c.user_id = u.id where c.id = ${wbEvents.customerId})`,
      customerProductName: sql<string | null>`(select c.product_name from wb_customers c where c.id = ${wbEvents.customerId})`,
      // Pull the most-likely "subject" id out of the JSONB.
      // For most actions one of these is the meaningful identifier.
      subject: sql<string | null>`coalesce(
        ${wbEvents.properties}->>'subscriberId',
        ${wbEvents.properties}->>'runId',
        ${wbEvents.properties}->>'period'
      )`,
      properties: wbEvents.properties,
    })
    .from(wbEvents)
    .leftJoin(users, eq(users.id, wbEvents.userId))
    .where(and(...conditions))
    .orderBy(desc(wbEvents.createdAt))
    .limit(limit)

  return rows.map((r) => ({
    ...r,
    action: r.action ?? '(unknown)',
  }))
}

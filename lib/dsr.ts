/**
 * Spec 25 — DSR (Data Subject Request) primitives shared between the CLI
 * (scripts/dsr.ts) and the admin UI (/admin/subscribers row actions).
 *
 * Two operations:
 *   - exportByEmail   — Art. 15 access request, returns full JSON bundle
 *   - deleteByEmail   — Art. 17 erasure request, hard-deletes subscriber +
 *                       email rows across all customers (cascades via FKs)
 *
 * Both operations are intentionally email-scoped (not customer-scoped) — a
 * single subscriber email may exist on multiple Winback customers' campaigns
 * (e.g., the same person churned from Acme AND from Linear) and a GDPR
 * request must cover all of them.
 */

import { db } from './db'
import { churnedSubscribers, emailsSent } from './schema'
import { eq, inArray } from 'drizzle-orm'

export interface DsrExportBundle {
  email: string
  found: boolean
  subscribers: Array<typeof churnedSubscribers.$inferSelect>
  emails: Array<typeof emailsSent.$inferSelect>
}

/**
 * Export every row we hold for an email across wb_churned_subscribers +
 * wb_emails_sent (joined via subscriber_id). Returns `found: false` and empty
 * arrays if nothing matches — never throws on no-match.
 */
export async function exportByEmail(email: string): Promise<DsrExportBundle> {
  const subs = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.email, email))

  if (subs.length === 0) {
    return { email, found: false, subscribers: [], emails: [] }
  }

  const subIds = subs.map((s) => s.id)
  const emails = await db
    .select()
    .from(emailsSent)
    .where(inArray(emailsSent.subscriberId, subIds))

  return { email, found: true, subscribers: subs, emails }
}

export interface DsrDeleteResult {
  email: string
  deletedSubscribers: number
  deletedEmails: number
}

/**
 * Hard-delete every subscriber row + their emails for an email address.
 * Uses the existing FK cascade on wb_emails_sent.subscriber_id, but we
 * explicitly delete email rows first to keep the count visible.
 *
 * The CLI prompts for typed confirmation before calling this; the admin UI
 * does the same with a modal. This function does not gate — callers must.
 */
export async function deleteByEmail(email: string): Promise<DsrDeleteResult> {
  const subs = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.email, email))

  if (subs.length === 0) {
    return { email, deletedSubscribers: 0, deletedEmails: 0 }
  }

  const subIds = subs.map((s) => s.id)
  const emailRows = await db
    .select({ id: emailsSent.id })
    .from(emailsSent)
    .where(inArray(emailsSent.subscriberId, subIds))

  await db.delete(emailsSent).where(inArray(emailsSent.subscriberId, subIds))
  await db.delete(churnedSubscribers).where(inArray(churnedSubscribers.id, subIds))

  return {
    email,
    deletedSubscribers: subs.length,
    deletedEmails: emailRows.length,
  }
}

/**
 * Delete a single subscriber by id (used by the admin UI when the support
 * agent has already filtered to one specific row, vs. a blanket email match).
 * Cascades email rows. Returns counts.
 */
export async function deleteBySubscriberId(subscriberId: string): Promise<DsrDeleteResult> {
  const [sub] = await db
    .select({ id: churnedSubscribers.id, email: churnedSubscribers.email })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!sub) {
    return { email: '', deletedSubscribers: 0, deletedEmails: 0 }
  }

  const emailRows = await db
    .select({ id: emailsSent.id })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, subscriberId))

  await db.delete(emailsSent).where(eq(emailsSent.subscriberId, subscriberId))
  await db.delete(churnedSubscribers).where(eq(churnedSubscribers.id, subscriberId))

  return {
    email: sub.email ?? '',
    deletedSubscribers: 1,
    deletedEmails: emailRows.length,
  }
}

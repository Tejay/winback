/**
 * Spec 27 — Subscriber Inspector data assembly.
 *
 * Joins wb_churned_subscribers + wb_emails_sent + wb_events for one
 * subscriber id, returns a single payload for the timeline view. Read-only.
 */

import { sql, eq, and, asc, desc, inArray } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import {
  churnedSubscribers,
  customers,
  users,
  emailsSent as emailsSentTable,
  wbEvents,
} from '../schema'

export interface InspectorEmail {
  id: string
  type: string                  // 'exit' | 'followup' | 'dunning'
  subject: string | null
  bodyText: string | null       // null for historical rows pre-spec-27
  sentAt: Date | null
  repliedAt: Date | null
}

export interface InspectorOutcomeEvent {
  id: string
  name: string                  // founder_handoff_triggered | subscriber_recovered | subscriber_auto_lost
  createdAt: Date
  properties: Record<string, unknown>
}

export interface InspectorPayload {
  subscriber: {
    id: string
    customerId: string
    customerEmail: string | null
    customerProductName: string | null
    customerFounderName: string | null
    name: string | null
    email: string | null
    planName: string | null
    mrrCents: number
    status: string | null
    cancelledAt: Date | null
    doNotContact: boolean | null
    founderHandoffAt: Date | null
    founderHandoffResolvedAt: Date | null
    aiPausedUntil: Date | null
    aiPausedReason: string | null
    // signals at churn (snapshot stored on the row)
    stripeEnum: string | null
    stripeComment: string | null
    tenureDays: number | null
    everUpgraded: boolean | null
    nearRenewal: boolean | null
    paymentFailures: number | null
    previousSubs: number | null
    billingPortalClickedAt: Date | null
    // most recent reply (limitation noted in UI — earlier replies aren't preserved)
    replyText: string | null
    // latest classifier output
    tier: number | null
    confidence: string | null
    cancellationReason: string | null
    cancellationCategory: string | null
    triggerNeed: string | null
    handoffReasoning: string | null
    recoveryLikelihood: string | null
  } | null
  emails: InspectorEmail[]
  outcomeEvents: InspectorOutcomeEvent[]
}

/** The set of event names we surface in the timeline as outcome markers. */
const OUTCOME_EVENT_NAMES = [
  'founder_handoff_triggered',
  'subscriber_recovered',
  'subscriber_auto_lost',
  'subscriber_unsubscribed',
  'handoff_resolved_manually',
  'handoff_snoozed',
  'ai_paused',
  'ai_resumed',
  'proactive_nudge_sent',
] as const

/**
 * Assemble the full inspector payload for a single subscriber. Returns
 * `subscriber: null` if the id doesn't match any row (caller renders 404).
 */
export async function buildInspectorPayload(subscriberId: string): Promise<InspectorPayload> {
  const ro = getDbReadOnly()

  const [subRow] = await ro
    .select({
      id: churnedSubscribers.id,
      customerId: churnedSubscribers.customerId,
      customerEmail: users.email,
      customerProductName: customers.productName,
      customerFounderName: customers.founderName,
      name: churnedSubscribers.name,
      email: churnedSubscribers.email,
      planName: churnedSubscribers.planName,
      mrrCents: churnedSubscribers.mrrCents,
      status: churnedSubscribers.status,
      cancelledAt: churnedSubscribers.cancelledAt,
      doNotContact: churnedSubscribers.doNotContact,
      founderHandoffAt: churnedSubscribers.founderHandoffAt,
      founderHandoffResolvedAt: churnedSubscribers.founderHandoffResolvedAt,
      aiPausedUntil: churnedSubscribers.aiPausedUntil,
      aiPausedReason: churnedSubscribers.aiPausedReason,
      stripeEnum: churnedSubscribers.stripeEnum,
      stripeComment: churnedSubscribers.stripeComment,
      tenureDays: churnedSubscribers.tenureDays,
      everUpgraded: churnedSubscribers.everUpgraded,
      nearRenewal: churnedSubscribers.nearRenewal,
      paymentFailures: churnedSubscribers.paymentFailures,
      previousSubs: churnedSubscribers.previousSubs,
      billingPortalClickedAt: churnedSubscribers.billingPortalClickedAt,
      replyText: churnedSubscribers.replyText,
      tier: churnedSubscribers.tier,
      confidence: churnedSubscribers.confidence,
      cancellationReason: churnedSubscribers.cancellationReason,
      cancellationCategory: churnedSubscribers.cancellationCategory,
      triggerNeed: churnedSubscribers.triggerNeed,
      handoffReasoning: churnedSubscribers.handoffReasoning,
      recoveryLikelihood: churnedSubscribers.recoveryLikelihood,
    })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(customers.id, churnedSubscribers.customerId))
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!subRow) {
    return { subscriber: null, emails: [], outcomeEvents: [] }
  }

  const [emails, outcomeEvents] = await Promise.all([
    ro
      .select({
        id: emailsSentTable.id,
        type: emailsSentTable.type,
        subject: emailsSentTable.subject,
        bodyText: emailsSentTable.bodyText,
        sentAt: emailsSentTable.sentAt,
        repliedAt: emailsSentTable.repliedAt,
      })
      .from(emailsSentTable)
      .where(eq(emailsSentTable.subscriberId, subscriberId))
      .orderBy(asc(emailsSentTable.sentAt)),
    ro
      .select({
        id: wbEvents.id,
        name: wbEvents.name,
        createdAt: wbEvents.createdAt,
        properties: wbEvents.properties,
      })
      .from(wbEvents)
      .where(
        and(
          inArray(wbEvents.name, OUTCOME_EVENT_NAMES as unknown as string[]),
          // Filter on the JSONB property — events that reference this subscriber
          // are written with subscriberId inside `properties` (no top-level FK).
          sql`${wbEvents.properties}->>'subscriberId' = ${subscriberId}`,
        ),
      )
      .orderBy(desc(wbEvents.createdAt)),
  ])

  return {
    subscriber: subRow,
    emails,
    outcomeEvents,
  }
}

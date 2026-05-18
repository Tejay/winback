/**
 * Spec 54 — Drain on subscribe.
 *
 * Cron-driven processing of events that piled up in
 * wb_churned_subscribers during the merchant's paused window. Three
 * categories:
 *   A — late cancellations (queued exit emails)
 *   B — late dunning (queued payment-recovery emails)
 *   C — late replies (queued win-back replies)
 *
 * Per-row state via wb_churned_subscribers.pause_drain_processed_at.
 * Set when a row reaches a terminal outcome (sent / classifier-
 * suppressed / handoff). Unset → row stays in the queue, retried on
 * the next cron tick. Per-row idempotency in scheduleExitEmail /
 * sendReplyEmail / sendDunningEmail prevents double-sends on retry.
 *
 * Entry points:
 *   - runDrainTick(limit) — called by /api/cron/drain-paused-queue
 *   - getPausedQueueCounts(customerId) — preflight counts for the
 *     /billing/success UX line
 */
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent, subscriberReplies } from '@/lib/schema'
import { and, eq, isNull, isNotNull, ne, or, sql, lte } from 'drizzle-orm'
import { classifySubscriber } from './classifier'
import { buildConversationThread } from './conversation'
import {
  scheduleExitEmail,
  sendDunningEmail,
  sendDunningFollowupEmail,
  sendReplyEmail,
  buildFromDisplayName,
} from './email'
import { logEvent } from './events'
import type { SubscriberSignals } from './types'

const DUNNING_REASON = 'Payment failed'
const QUEUE_HORIZON_DAYS = 180
const DUNNING_QUIET_DAYS = 7
const SEND_THROTTLE_MS = 120

type DrainAction = 'sent' | 'skipped_classifier' | 'handoff' | 'failed'

interface DrainItem {
  subscriberId: string
  customerId: string
  category: 'cancellation' | 'dunning' | 'reply'
  action: DrainAction
  reasoning?: string
  errorMessage?: string
}

export interface QueueCounts {
  cancellations: number
  paymentRecoveries: number
  replies: number
  total: number
}

export interface TickSummary {
  rowsConsidered: number
  rowsProcessed: number
  sent: number
  skippedClassifier: number
  handoff: number
  failed: number
  durationMs: number
}

// ─── public ────────────────────────────────────────────────────────────────

/**
 * Counts of subscribers in the drain queue for one customer. Used by
 * /billing/success to render the "we're processing N events…" line.
 * Cheap — backed by the partial index on pause_drain_processed_at.
 */
export async function getPausedQueueCounts(customerId: string): Promise<QueueCounts> {
  const [cancRow] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(and(
      eq(churnedSubscribers.customerId, customerId),
      isNotNull(customers.activatedAt),
      isNotNull(customers.stripeSubscriptionId),
      isNull(churnedSubscribers.pauseDrainProcessedAt),
      eq(churnedSubscribers.status, 'pending'),
      isNotNull(churnedSubscribers.email),
      eq(churnedSubscribers.doNotContact, false),
      isNull(churnedSubscribers.founderHandoffAt),
      sql`${churnedSubscribers.cancelledAt} > NOW() - INTERVAL '${sql.raw(String(QUEUE_HORIZON_DAYS))} days'`,
    ))

  const [pmtRow] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(and(
      eq(churnedSubscribers.customerId, customerId),
      isNotNull(customers.activatedAt),
      isNotNull(customers.stripeSubscriptionId),
      isNull(churnedSubscribers.pauseDrainProcessedAt),
      or(
        eq(churnedSubscribers.dunningState, 'awaiting_retry'),
        eq(churnedSubscribers.dunningState, 'final_retry_pending'),
      ),
      isNotNull(churnedSubscribers.email),
      eq(churnedSubscribers.doNotContact, false),
      sql`${churnedSubscribers.createdAt} > NOW() - INTERVAL '${sql.raw(String(QUEUE_HORIZON_DAYS))} days'`,
    ))

  const [replyRow] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(and(
      eq(churnedSubscribers.customerId, customerId),
      isNotNull(customers.activatedAt),
      isNotNull(customers.stripeSubscriptionId),
      isNull(churnedSubscribers.pauseDrainProcessedAt),
      // Spec 71 — replaced isNotNull(replyText) with EXISTS against the
      // new wb_subscriber_replies table.
      sql`EXISTS (SELECT 1 FROM ${subscriberReplies} WHERE ${subscriberReplies.subscriberId} = ${churnedSubscribers.id})`,
      isNotNull(churnedSubscribers.lastEngagementAt),
      isNotNull(churnedSubscribers.email),
      eq(churnedSubscribers.doNotContact, false),
      isNull(churnedSubscribers.founderHandoffAt),
      sql`${churnedSubscribers.lastEngagementAt} > NOW() - INTERVAL '${sql.raw(String(QUEUE_HORIZON_DAYS))} days'`,
    ))

  const cancellations = Number(cancRow?.n ?? 0)
  const paymentRecoveries = Number(pmtRow?.n ?? 0)
  const replies = Number(replyRow?.n ?? 0)
  return {
    cancellations,
    paymentRecoveries,
    replies,
    total: cancellations + paymentRecoveries + replies,
  }
}

/**
 * One cron tick. Selects up to `limit` rows across the three queue
 * categories and processes them serially with a small throttle to
 * stay under Resend's 10/s rate limit.
 *
 * No-ops cleanly on zero rows; per-row errors are caught and logged
 * (one bad row never stops the tick).
 */
export async function runDrainTick(limit: number): Promise<TickSummary> {
  const startedAt = Date.now()
  const summary: TickSummary = {
    rowsConsidered: 0,
    rowsProcessed: 0,
    sent: 0,
    skippedClassifier: 0,
    handoff: 0,
    failed: 0,
    durationMs: 0,
  }

  // Three category queries; cap each to `limit` and then trim to `limit`
  // across the combined set. Cancellations first, then payment recoveries,
  // then replies — deterministic order for predictable test behaviour.
  const cancRows = await selectCancellationQueue(limit)
  const remainingAfterCanc = Math.max(0, limit - cancRows.length)
  const pmtRows = remainingAfterCanc > 0 ? await selectDunningQueue(remainingAfterCanc) : []
  const remainingAfterPmt = Math.max(0, limit - cancRows.length - pmtRows.length)
  const replyRows = remainingAfterPmt > 0 ? await selectReplyQueue(remainingAfterPmt) : []

  summary.rowsConsidered = cancRows.length + pmtRows.length + replyRows.length

  for (const sub of cancRows) {
    const item = await safeProcess(() => processCancellationItem(sub))
    tally(summary, item)
    await emitProcessedEvent(item)
    await sleep(SEND_THROTTLE_MS)
  }
  for (const sub of pmtRows) {
    const item = await safeProcess(() => processDunningItem(sub))
    tally(summary, item)
    await emitProcessedEvent(item)
    await sleep(SEND_THROTTLE_MS)
  }
  for (const sub of replyRows) {
    const item = await safeProcess(() => processReplyItem(sub))
    tally(summary, item)
    await emitProcessedEvent(item)
    await sleep(SEND_THROTTLE_MS)
  }

  summary.durationMs = Date.now() - startedAt

  if (summary.rowsConsidered > 0) {
    await logEvent({
      name: 'pause_drain_tick_summary',
      properties: {
        rowsConsidered: summary.rowsConsidered,
        rowsProcessed: summary.rowsProcessed,
        sent: summary.sent,
        skippedClassifier: summary.skippedClassifier,
        handoff: summary.handoff,
        failed: summary.failed,
        durationMs: summary.durationMs,
      },
    })
  }

  return summary
}

// ─── queue selection ───────────────────────────────────────────────────────

type SubscriberRow = typeof churnedSubscribers.$inferSelect

async function selectCancellationQueue(limit: number): Promise<SubscriberRow[]> {
  return db
    .select()
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(and(
      isNotNull(customers.activatedAt),
      isNotNull(customers.stripeSubscriptionId),
      isNull(churnedSubscribers.pauseDrainProcessedAt),
      eq(churnedSubscribers.status, 'pending'),
      isNotNull(churnedSubscribers.email),
      eq(churnedSubscribers.doNotContact, false),
      isNull(churnedSubscribers.founderHandoffAt),
      or(
        isNull(churnedSubscribers.aiPausedUntil),
        lte(churnedSubscribers.aiPausedUntil, sql`NOW()`),
      ),
      sql`${churnedSubscribers.cancelledAt} > NOW() - INTERVAL '${sql.raw(String(QUEUE_HORIZON_DAYS))} days'`,
      // Defence in depth — even if status got reset, never double-send
      sql`NOT EXISTS (
        SELECT 1 FROM ${emailsSent}
        WHERE ${emailsSent.subscriberId} = ${churnedSubscribers.id}
          AND ${emailsSent.type} IN ('exit','reengagement')
      )`,
    ))
    .limit(limit)
    .then((rows) => rows.map((r) => r.wb_churned_subscribers))
}

async function selectDunningQueue(limit: number): Promise<SubscriberRow[]> {
  return db
    .select()
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(and(
      isNotNull(customers.activatedAt),
      isNotNull(customers.stripeSubscriptionId),
      isNull(churnedSubscribers.pauseDrainProcessedAt),
      or(
        eq(churnedSubscribers.dunningState, 'awaiting_retry'),
        eq(churnedSubscribers.dunningState, 'final_retry_pending'),
      ),
      isNotNull(churnedSubscribers.email),
      eq(churnedSubscribers.doNotContact, false),
      sql`${churnedSubscribers.createdAt} > NOW() - INTERVAL '${sql.raw(String(QUEUE_HORIZON_DAYS))} days'`,
      or(
        isNull(churnedSubscribers.dunningLastTouchAt),
        sql`${churnedSubscribers.dunningLastTouchAt} < NOW() - INTERVAL '${sql.raw(String(DUNNING_QUIET_DAYS))} days'`,
      ),
    ))
    .limit(limit)
    .then((rows) => rows.map((r) => r.wb_churned_subscribers))
}

async function selectReplyQueue(limit: number): Promise<SubscriberRow[]> {
  return db
    .select()
    .from(churnedSubscribers)
    .innerJoin(customers, eq(churnedSubscribers.customerId, customers.id))
    .where(and(
      isNotNull(customers.activatedAt),
      isNotNull(customers.stripeSubscriptionId),
      isNull(churnedSubscribers.pauseDrainProcessedAt),
      // Spec 71 — replaced isNotNull(replyText) with EXISTS against the
      // new wb_subscriber_replies table.
      sql`EXISTS (SELECT 1 FROM ${subscriberReplies} WHERE ${subscriberReplies.subscriberId} = ${churnedSubscribers.id})`,
      isNotNull(churnedSubscribers.lastEngagementAt),
      isNotNull(churnedSubscribers.email),
      eq(churnedSubscribers.doNotContact, false),
      isNull(churnedSubscribers.founderHandoffAt),
      sql`${churnedSubscribers.lastEngagementAt} > NOW() - INTERVAL '${sql.raw(String(QUEUE_HORIZON_DAYS))} days'`,
      // No followup email sent for THIS reply (i.e., no emailsSent row of
      // type='followup' newer than the latest engagement timestamp).
      sql`NOT EXISTS (
        SELECT 1 FROM ${emailsSent}
        WHERE ${emailsSent.subscriberId} = ${churnedSubscribers.id}
          AND ${emailsSent.type} = 'followup'
          AND ${emailsSent.sentAt} > ${churnedSubscribers.lastEngagementAt}
      )`,
    ))
    .limit(limit)
    .then((rows) => rows.map((r) => r.wb_churned_subscribers))
}

// ─── per-row processing ────────────────────────────────────────────────────

async function processCancellationItem(sub: SubscriberRow): Promise<DrainItem> {
  // Re-classify with daysElapsedSinceEvent so the model can factor in
  // time decay against the cancellation reason.
  const [customer] = await db.select().from(customers).where(eq(customers.id, sub.customerId)).limit(1)
  if (!customer) throw new Error(`customer ${sub.customerId} not found`)

  const cancelledAt = sub.cancelledAt ?? new Date()
  const daysElapsedSinceEvent = Math.floor((Date.now() - cancelledAt.getTime()) / (1000 * 60 * 60 * 24))

  const signals: SubscriberSignals = {
    stripeCustomerId: sub.stripeCustomerId,
    stripeSubscriptionId: sub.stripeSubscriptionId ?? '',
    stripePriceId: sub.stripePriceId ?? null,
    email: sub.email,
    name: sub.name,
    planName: sub.planName ?? 'Unknown',
    mrrCents: sub.mrrCents,
    tenureDays: sub.tenureDays ?? 0,
    everUpgraded: sub.everUpgraded ?? false,
    nearRenewal: sub.nearRenewal ?? false,
    paymentFailures: sub.paymentFailures ?? 0,
    previousSubs: sub.previousSubs ?? 0,
    stripeEnum: sub.stripeEnum,
    stripeComment: sub.stripeComment,
    conversationThread: await buildConversationThread(sub.id),
    billingPortalClicked: !!sub.billingPortalClickedAt,
    cancelledAt,
    daysElapsedSinceEvent,
  }

  const classification = await classifySubscriber(signals, {
    founderName: customer.founderName ?? undefined,
    productName: customer.productName ?? undefined,
  })

  // Persist the refreshed classification + suppress reasoning to the row
  // so the dashboard drawer can surface the AI's reasoning (handoffReasoning
  // is the existing visible field).
  await db
    .update(churnedSubscribers)
    .set({
      tier: classification.tier,
      confidence: String(classification.confidence),
      cancellationReason: classification.cancellationReason,
      cancellationCategory: classification.cancellationCategory,
      triggerKeyword: classification.triggerKeyword,
      triggerNeed: classification.triggerNeed,
      winBackSubject: classification.winBackSubject,
      winBackBody: classification.winBackBody,
      handoffReasoning: classification.handoffReasoning,
      recoveryLikelihood: classification.recoveryLikelihood,
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, sub.id))

  if (classification.suppress || classification.tier === 4 || !classification.firstMessage) {
    await markProcessed(sub.id)
    return {
      subscriberId: sub.id,
      customerId: sub.customerId,
      category: 'cancellation',
      action: 'skipped_classifier',
      reasoning: classification.suppressReason ?? classification.handoffReasoning,
    }
  }

  if (classification.handoff) {
    // scheduleExitEmail handles the handoff path internally (calls
    // triggerFounderHandoff). After it returns, founderHandoffAt is set
    // on the row, so we can mark drain-processed.
    await scheduleExitEmail({
      subscriberId: sub.id,
      email: sub.email!,
      classification,
      fromName: buildFromDisplayName({ founderName: customer.founderName, productName: customer.productName }),
    })
    await markProcessed(sub.id)
    return { subscriberId: sub.id, customerId: sub.customerId, category: 'cancellation', action: 'handoff' }
  }

  await scheduleExitEmail({
    subscriberId: sub.id,
    email: sub.email!,
    classification,
    fromName: buildFromDisplayName({ founderName: customer.founderName, productName: customer.productName }),
  })
  await markProcessed(sub.id)
  return { subscriberId: sub.id, customerId: sub.customerId, category: 'cancellation', action: 'sent' }
}

async function processDunningItem(sub: SubscriberRow): Promise<DrainItem> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, sub.customerId)).limit(1)
  if (!customer) throw new Error(`customer ${sub.customerId} not found`)

  // dunning emails use template based on dunningState/touchCount; no
  // classifier judgement applies.
  const touchCount = sub.dunningTouchCount ?? 0
  const fromName = buildFromDisplayName({ founderName: customer.founderName, productName: customer.productName })
  const planName = sub.planName ?? 'your plan'
  const amountDue = sub.mrrCents
  const currency = 'usd' // wb_churned_subscribers doesn't track per-sub currency yet; safe default
  const nextRetryDate = sub.nextPaymentAttemptAt
  const isFinalRetry = sub.dunningState === 'final_retry_pending'

  if (touchCount === 0) {
    await sendDunningEmail({
      subscriberId: sub.id,
      email: sub.email!,
      fromName,
      customerName: sub.name,
      planName,
      amountDue,
      currency,
      nextRetryDate,
    })
  } else {
    // sendDunningFollowupEmail requires a non-null retryDate. If Stripe's
    // next-retry hint is absent (rare for in-flight dunning), pass a near-
    // term placeholder so the template can render cleanly. The email's
    // value is the reminder itself, not the precise date.
    const retryDate = nextRetryDate ?? new Date(Date.now() + 24 * 60 * 60 * 1000)
    await sendDunningFollowupEmail({
      subscriberId: sub.id,
      email: sub.email!,
      fromName,
      customerName: sub.name,
      planName,
      amountDue,
      currency,
      retryDate,
      isFinalRetry,
    })
  }
  await markProcessed(sub.id)
  return { subscriberId: sub.id, customerId: sub.customerId, category: 'dunning', action: 'sent' }
}

async function processReplyItem(sub: SubscriberRow): Promise<DrainItem> {
  const [customer] = await db.select().from(customers).where(eq(customers.id, sub.customerId)).limit(1)
  if (!customer) throw new Error(`customer ${sub.customerId} not found`)

  const eventAt = sub.lastEngagementAt ?? sub.cancelledAt ?? new Date()
  const daysElapsedSinceEvent = Math.floor((Date.now() - eventAt.getTime()) / (1000 * 60 * 60 * 24))

  const signals: SubscriberSignals = {
    stripeCustomerId: sub.stripeCustomerId,
    stripeSubscriptionId: sub.stripeSubscriptionId ?? '',
    stripePriceId: sub.stripePriceId ?? null,
    email: sub.email,
    name: sub.name,
    planName: sub.planName ?? 'Unknown',
    mrrCents: sub.mrrCents,
    tenureDays: sub.tenureDays ?? 0,
    everUpgraded: sub.everUpgraded ?? false,
    nearRenewal: sub.nearRenewal ?? false,
    paymentFailures: sub.paymentFailures ?? 0,
    previousSubs: sub.previousSubs ?? 0,
    stripeEnum: sub.stripeEnum,
    stripeComment: sub.stripeComment,
    conversationThread: await buildConversationThread(sub.id),
    billingPortalClicked: !!sub.billingPortalClickedAt,
    cancelledAt: sub.cancelledAt ?? new Date(),
    daysElapsedSinceEvent,
  }

  const classification = await classifySubscriber(signals, {
    founderName: customer.founderName ?? undefined,
    productName: customer.productName ?? undefined,
  })

  // Persist refreshed classification for visibility
  await db
    .update(churnedSubscribers)
    .set({
      tier: classification.tier,
      confidence: String(classification.confidence),
      handoffReasoning: classification.handoffReasoning,
      recoveryLikelihood: classification.recoveryLikelihood,
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, sub.id))

  // sendReplyEmail handles classification.handoff and classification.suppress
  // internally and returns { sent, reason }. Whatever it returns, the row
  // has reached a terminal decision and should be marked drain-processed.
  const result = await sendReplyEmail({
    subscriberId: sub.id,
    email: sub.email!,
    classification,
    fromName: buildFromDisplayName({ founderName: customer.founderName, productName: customer.productName }),
  })

  await markProcessed(sub.id)

  if (result.sent) {
    return { subscriberId: sub.id, customerId: sub.customerId, category: 'reply', action: 'sent' }
  }
  if (result.reason === 'ai_handoff') {
    return { subscriberId: sub.id, customerId: sub.customerId, category: 'reply', action: 'handoff' }
  }
  return {
    subscriberId: sub.id,
    customerId: sub.customerId,
    category: 'reply',
    action: 'skipped_classifier',
    reasoning: result.reason,
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function markProcessed(subscriberId: string): Promise<void> {
  await db
    .update(churnedSubscribers)
    .set({ pauseDrainProcessedAt: new Date(), updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))
}

async function safeProcess(fn: () => Promise<DrainItem>): Promise<DrainItem> {
  try {
    return await fn()
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error('[pause-drain] item failed:', errorMessage)
    return {
      subscriberId: '?',
      customerId: '?',
      category: 'cancellation',
      action: 'failed',
      errorMessage,
    }
  }
}

function tally(summary: TickSummary, item: DrainItem): void {
  if (item.action !== 'failed') summary.rowsProcessed += 1
  if (item.action === 'sent') summary.sent += 1
  if (item.action === 'skipped_classifier') summary.skippedClassifier += 1
  if (item.action === 'handoff') summary.handoff += 1
  if (item.action === 'failed') summary.failed += 1
}

async function emitProcessedEvent(item: DrainItem): Promise<void> {
  // Don't emit for items where safeProcess swallowed the error before
  // we could capture subscriberId — those already logged via console.error.
  if (item.subscriberId === '?') return
  await logEvent({
    name: 'pause_drain_processed',
    customerId: item.customerId,
    properties: {
      subscriberId: item.subscriberId,
      category: item.category,
      action: item.action,
      reasoning: item.reasoning,
    },
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Mark DUNNING_REASON as used (referenced in spec for the dunning cohort
// definition; the actual filter uses dunning_state, not the reason text).
void DUNNING_REASON

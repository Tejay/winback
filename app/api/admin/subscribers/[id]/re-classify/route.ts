import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { churnedSubscribers, customers, emailsSent } from '@/lib/schema'
import { eq, count } from 'drizzle-orm'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { logEvent } from '@/src/winback/lib/events'
import type { SubscriberSignals } from '@/src/winback/lib/types'

/**
 * Spec 27 — Live classifier re-run.
 *
 * Reconstructs SubscriberSignals from the persisted subscriber row and runs
 * the classifier against today's prompt. Returns a side-by-side diff of
 * stored vs fresh values. Does NOT write to the DB.
 *
 * Costs ~$0.003 per call (real Anthropic API). Per CLAUDE.md, gated by
 * an exact-string confirmation parameter so a misclick can't burn money.
 */

const COST_CONFIRMATION = 'I understand this costs ~$0.003'

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { id } = await ctx.params
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const body = await req.json().catch(() => ({}))
  if (body.confirmCost !== COST_CONFIRMATION) {
    return NextResponse.json(
      {
        error: `confirmCost field must equal the literal string: "${COST_CONFIRMATION}"`,
        costEstimate: 0.003,
      },
      { status: 400 },
    )
  }

  // Load subscriber + owning customer in one shot. Use the read/write `db`
  // here (not dbReadOnly) because we'll need to count emails_sent too — and
  // a single connection keeps the round-trips bounded.
  const [row] = await db
    .select({
      // subscriber columns we need to reconstruct SubscriberSignals
      stripeCustomerId: churnedSubscribers.stripeCustomerId,
      stripeSubscriptionId: churnedSubscribers.stripeSubscriptionId,
      stripePriceId: churnedSubscribers.stripePriceId,
      email: churnedSubscribers.email,
      name: churnedSubscribers.name,
      planName: churnedSubscribers.planName,
      mrrCents: churnedSubscribers.mrrCents,
      tenureDays: churnedSubscribers.tenureDays,
      everUpgraded: churnedSubscribers.everUpgraded,
      nearRenewal: churnedSubscribers.nearRenewal,
      paymentFailures: churnedSubscribers.paymentFailures,
      previousSubs: churnedSubscribers.previousSubs,
      stripeEnum: churnedSubscribers.stripeEnum,
      stripeComment: churnedSubscribers.stripeComment,
      replyText: churnedSubscribers.replyText,
      billingPortalClickedAt: churnedSubscribers.billingPortalClickedAt,
      cancelledAt: churnedSubscribers.cancelledAt,
      // stored classification (for the diff)
      storedTier: churnedSubscribers.tier,
      storedConfidence: churnedSubscribers.confidence,
      storedCancellationReason: churnedSubscribers.cancellationReason,
      storedCancellationCategory: churnedSubscribers.cancellationCategory,
      storedTriggerNeed: churnedSubscribers.triggerNeed,
      storedHandoffReasoning: churnedSubscribers.handoffReasoning,
      storedRecoveryLikelihood: churnedSubscribers.recoveryLikelihood,
      // customer context for the classifier prompt
      customerId: churnedSubscribers.customerId,
      founderName: customers.founderName,
      productName: customers.productName,
      changelogText: customers.changelogText,
    })
    .from(churnedSubscribers)
    .innerJoin(customers, eq(customers.id, churnedSubscribers.customerId))
    .where(eq(churnedSubscribers.id, id))
    .limit(1)

  if (!row) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  // Count emails sent so the budget-awareness factor is calibrated to today.
  const [sentRow] = await db
    .select({ n: count() })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, id))

  const signals: SubscriberSignals = {
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId ?? '',
    stripePriceId: row.stripePriceId ?? null,
    email: row.email,
    name: row.name,
    planName: row.planName ?? 'Unknown',
    mrrCents: row.mrrCents,
    tenureDays: row.tenureDays ?? 0,
    everUpgraded: row.everUpgraded ?? false,
    nearRenewal: row.nearRenewal ?? false,
    paymentFailures: row.paymentFailures ?? 0,
    previousSubs: row.previousSubs ?? 0,
    stripeEnum: row.stripeEnum,
    stripeComment: row.stripeComment,
    replyText: row.replyText,
    billingPortalClicked: !!row.billingPortalClickedAt,
    cancelledAt: row.cancelledAt ?? new Date(),
    emailsSent: sentRow?.n ?? 0,
  }

  let fresh
  try {
    fresh = await classifySubscriber(signals, {
      founderName: row.founderName ?? undefined,
      productName: row.productName ?? undefined,
      changelog: row.changelogText ?? undefined,
    })
  } catch (err) {
    return NextResponse.json(
      {
        error: 'Classifier failed',
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }

  // Audit BEFORE returning so the spend trail lands even if the response
  // is interrupted en route to the client.
  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    customerId: row.customerId,
    properties: {
      action: 'classifier_re_run',
      subscriberId: id,
      costEstimate: 0.003,
      // Quick-glance diff — full diff is computed client-side.
      tierShifted: row.storedTier !== fresh.tier,
      likelihoodShifted: row.storedRecoveryLikelihood !== fresh.recoveryLikelihood,
    },
  })

  return NextResponse.json({
    ok: true,
    stored: {
      tier: row.storedTier,
      confidence: row.storedConfidence ? Number(row.storedConfidence) : null,
      cancellationReason: row.storedCancellationReason,
      cancellationCategory: row.storedCancellationCategory,
      triggerNeed: row.storedTriggerNeed,
      handoffReasoning: row.storedHandoffReasoning,
      recoveryLikelihood: row.storedRecoveryLikelihood,
    },
    fresh: {
      tier: fresh.tier,
      confidence: fresh.confidence,
      cancellationReason: fresh.cancellationReason,
      cancellationCategory: fresh.cancellationCategory,
      triggerNeed: fresh.triggerNeed,
      handoffReasoning: fresh.handoffReasoning,
      recoveryLikelihood: fresh.recoveryLikelihood,
      handoff: fresh.handoff,
      tierReason: fresh.tierReason,
      firstMessage: fresh.firstMessage,
    },
    signalsUsed: signals,
  })
}

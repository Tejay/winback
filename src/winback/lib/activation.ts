import { db } from '@/lib/db'
import { customers, recoveries, churnedSubscribers } from '@/lib/schema'
import { eq, and, isNull, desc } from 'drizzle-orm'
import {
  getOrCreatePlatformCustomer,
  getCurrentDefaultPaymentMethodId,
} from './platform-billing'
import { ensurePlatformSubscription } from './subscription'
import { isCustomerOnPilot, getPilotUntil } from './pilot'
import { logEvent } from './events'
import { sendPlatformTrialCompleteEmail } from './billing-notifications'

/**
 * Phase A — Single converging function for activating a customer's billing.
 *
 * Called from two places (Phase B will wire these):
 *   1. Webhook handlers, after inserting a recovery (win-back or card-save)
 *   2. The card-capture webhook, after a customer adds their first card
 *
 * Reads current state and converges to the right outcome:
 *
 *   - No recoveries delivered yet → 'no_op'
 *   - First delivery, no card → mark `activated_at`, return 'awaiting_card'
 *     (any pending win-back perf fees stay queued in the DB until the card
 *     lands; refunds for fees that pre-existed activation also work because
 *     refundPerformanceFee handles missing item IDs)
 *   - Activated but still no card → 'awaiting_card' (no-op)
 *   - Card on file, no subscription yet → create subscription, charge any
 *     pending perf fees, return 'active'
 *   - Subscription exists, new perf fees pending → charge them, return 'active'
 *   - Everything settled → 'active'
 *
 * This function is idempotent and safe to call multiple times. Stripe
 * round-trips are minimised by checking DB state first.
 */
export type ActivationState =
  | { state: 'no_op' }
  | { state: 'awaiting_card'; activatedAt: Date }
  | { state: 'pilot'; pilotUntil: Date | null }   // Spec 31 — platform billing bypass while pilot active
  | {
      state: 'active'
      subscriptionId: string
      subscriptionCreated: boolean
      chargedRecoveryIds: string[]
    }

export async function ensureActivation(wbCustomerId: string): Promise<ActivationState> {
  const [cust] = await db
    .select({
      id: customers.id,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
      stripeSubscriptionId: customers.stripeSubscriptionId,
      activatedAt: customers.activatedAt,
    })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  if (!cust) throw new Error(`wb_customer ${wbCustomerId} not found`)

  const deliveriesExist = await hasAnyDelivery(wbCustomerId)
  if (!deliveriesExist) return { state: 'no_op' }

  // Spec 31 — pilot bypass. While pilot_until > now() we don't create the
  // platform Stripe subscription and we don't charge any pending perf fees.
  // Recoveries still record normally; the chargePerformanceFee gate also
  // skips per-recovery fees during the same window. After pilot_until the
  // very next ensureActivation call falls through this check and resumes
  // normal billing — no manual graduation step.
  if (await isCustomerOnPilot(wbCustomerId)) {
    const pilotUntil = await getPilotUntil(wbCustomerId)
    await logEvent({
      name: 'platform_billing_skipped_pilot',
      customerId: wbCustomerId,
      properties: { pilotUntil: pilotUntil?.toISOString() ?? null },
    })
    return { state: 'pilot', pilotUntil }
  }

  // Ensure a platform Stripe customer container exists so we can later
  // attach a card to it. Idempotent — no-op if already created.
  const platformCustomerId =
    cust.stripePlatformCustomerId ?? (await getOrCreatePlatformCustomer(wbCustomerId))

  // Mark activated_at on first qualifying delivery (audit trail) regardless
  // of whether we can create a subscription yet. Phase D — conditional UPDATE
  // so that two concurrent ensureActivation calls can't both "win the race"
  // and trample each other's clock; only the call whose UPDATE matches a
  // still-NULL activated_at takes effect, and the other is a no-op. Also
  // re-reads the row so any racer's value is observed.
  let activatedAt = cust.activatedAt
  if (!activatedAt) {
    const now = new Date()
    const claimed = await db
      .update(customers)
      .set({ activatedAt: now, updatedAt: now })
      .where(and(eq(customers.id, wbCustomerId), isNull(customers.activatedAt)))
      .returning({ activatedAt: customers.activatedAt })
    if (claimed.length) {
      activatedAt = claimed[0].activatedAt as Date
      // Spec 51 — we just won the race to set activatedAt. Send the
      // one-time trial-complete email (fire-and-forget; failures don't
      // block activation). Look up the most recent recovery row so we
      // can name the recovered subscriber + show MRR. Pilot customers
      // are skipped — they don't enter the paused-state UX.
      const isPilot = await isCustomerOnPilot(wbCustomerId)
      if (!isPilot) {
        const [first] = await db
          .select({
            name: churnedSubscribers.name,
            mrrCents: churnedSubscribers.mrrCents,
          })
          .from(recoveries)
          .innerJoin(churnedSubscribers, eq(recoveries.subscriberId, churnedSubscribers.id))
          .where(eq(recoveries.customerId, wbCustomerId))
          .orderBy(desc(recoveries.recoveredAt))
          .limit(1)
        sendPlatformTrialCompleteEmail({
          customerId: wbCustomerId,
          recoveredSubscriberName: first?.name ?? null,
          recoveredMrrCents: first?.mrrCents ?? 0,
        }).catch((err) =>
          console.error('[activation] failed to send trial-complete email', err)
        )
      }
    } else {
      // Lost the race — re-read whichever timestamp the winning call wrote.
      const [latest] = await db
        .select({ activatedAt: customers.activatedAt })
        .from(customers)
        .where(eq(customers.id, wbCustomerId))
        .limit(1)
      activatedAt = latest?.activatedAt ?? now
    }
  }

  // Without a card we can't charge a subscription. Wait for card capture
  // to call us again. Pending perf fees stay queued in the DB.
  const cardOnFile = await getCurrentDefaultPaymentMethodId(platformCustomerId)
  if (!cardOnFile) {
    return { state: 'awaiting_card', activatedAt }
  }

  // Spec 78 — perf fees no longer fire at activation. The Connect-side
  // `invoice.payment_succeeded` handler fires the fee when the recovered
  // subscriber's first non-zero invoice settles on the merchant's Stripe
  // account, billing 1× that invoice's amount_paid. This correctly handles
  // free trials, first-month-free promos, and plan changes (the basis is
  // what the merchant actually collected, not planMrrCents). Activation
  // only ensures the platform subscription exists so the webhook handler
  // has a subscription to attach the perf-fee invoice item to when the
  // time comes.
  const { subscriptionId, created } = await ensurePlatformSubscription(wbCustomerId)

  return {
    state: 'active',
    subscriptionId,
    subscriptionCreated: created,
    chargedRecoveryIds: [],
  }
}

async function hasAnyDelivery(customerId: string): Promise<boolean> {
  const rows = await db
    .select({ id: recoveries.id })
    .from(recoveries)
    .where(eq(recoveries.customerId, customerId))
    .limit(1)
  return rows.length > 0
}

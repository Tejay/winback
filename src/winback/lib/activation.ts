import { db } from '@/lib/db'
import { customers, recoveries } from '@/lib/schema'
import { eq, and, isNull } from 'drizzle-orm'
import {
  getOrCreatePlatformCustomer,
  getCurrentDefaultPaymentMethodId,
} from './platform-billing'
import { ensurePlatformSubscription } from './subscription'
import { chargePendingPerformanceFees } from './performance-fee'
import { logEvent } from './events'

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

  // Order matters: when there is no subscription yet, charge pending perf
  // fees FIRST (creates pending Stripe invoice items with no subscription
  // field). Then ensurePlatformSubscription creates the subscription, and
  // Stripe bundles the pending items onto the first invoice along with the
  // prorated $99. Result: one first invoice = $99 prorated + Σ(win-back fees).
  //
  // When the subscription already exists, charging order doesn't matter —
  // chargePerformanceFee attaches the item to the subscription and it
  // lands on the next cycle's invoice.
  const { chargedRecoveryIds } = await chargePendingPerformanceFees(wbCustomerId)
  const { subscriptionId, created } = await ensurePlatformSubscription(wbCustomerId)

  // Phase D — visibility: if a previously-activated customer just had queued
  // fees drained, that means an earlier activation left the queue partially
  // un-drained (transient Stripe error, late card capture, etc). The drain
  // is the self-heal; the event makes it inspectable from /admin/events.
  if (chargedRecoveryIds.length > 0 && cust.activatedAt) {
    logEvent({
      name: 'activation_self_heal',
      customerId: wbCustomerId,
      properties: {
        drainedCount: chargedRecoveryIds.length,
        recoveryIds: chargedRecoveryIds,
      },
    })
  }

  return {
    state: 'active',
    subscriptionId,
    subscriptionCreated: created,
    chargedRecoveryIds,
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

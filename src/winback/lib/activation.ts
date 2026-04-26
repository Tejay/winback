import { db } from '@/lib/db'
import { customers, recoveries } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import {
  getOrCreatePlatformCustomer,
  getCurrentDefaultPaymentMethodId,
} from './platform-billing'
import { ensurePlatformSubscription } from './subscription'
import { chargePendingPerformanceFees } from './performance-fee'

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
  // of whether we can create a subscription yet.
  let activatedAt = cust.activatedAt
  if (!activatedAt) {
    activatedAt = new Date()
    await db
      .update(customers)
      .set({ activatedAt, updatedAt: new Date() })
      .where(eq(customers.id, wbCustomerId))
  }

  // Without a card we can't charge a subscription. Wait for card capture
  // to call us again. Pending perf fees stay queued in the DB.
  const cardOnFile = await getCurrentDefaultPaymentMethodId(platformCustomerId)
  if (!cardOnFile) {
    return { state: 'awaiting_card', activatedAt }
  }

  // Card on file: ensure subscription exists. ensurePlatformSubscription
  // is itself idempotent and will skip Stripe if already active.
  const { subscriptionId, created } = await ensurePlatformSubscription(wbCustomerId)

  // Drain any queued win-back perf fees onto the live subscription cycle.
  const { chargedRecoveryIds } = await chargePendingPerformanceFees(wbCustomerId)

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

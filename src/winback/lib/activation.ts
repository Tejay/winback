import { db } from '@/lib/db'
import { customers, recoveries, churnedSubscribers } from '@/lib/schema'
import { eq, and, isNull, desc } from 'drizzle-orm'
import {
  getOrCreatePlatformCustomer,
  getCurrentDefaultPaymentMethodId,
} from './platform-billing'
import { ensurePlatformSubscription } from './subscription'
import { isCustomerOnPilot, getPilotUntil } from './pilot'
import { getCustomMonthlyCents } from './flat-rate'
import { logEvent } from './events'
import { sendPlatformTrialCompleteEmail } from './billing-notifications'
import { takeSnapshot } from './mrr-snapshot'
import { tierFromMrr, tierLabel } from './tiers'
import { tierConfig } from './billing-config'
import type { TierKey } from './tiers'
import { emitInternalAlert } from './internal-alert'
import type { MrrBreakdown, MrrPerCurrency } from './mrr'

/**
 * Two-phase activation:
 *
 *   Phase A (prepareActivation): fires from the post-recovery webhook hook.
 *   Reads the customer's Stripe live, computes MRR + tier, persists
 *   recommended_tier, and returns the state for the UI to render the
 *   activation confirmation page. NEVER creates a subscription on its own.
 *
 *   Phase B (commitActivation): fires from the explicit POST /api/billing/
 *   activate endpoint, which the activation page invokes when the customer
 *   clicks "Subscribe at $X/mo". Re-validates the confirmed tier against the
 *   recommended_tier, ensures a card is on file, creates the subscription.
 *
 * The split exists to make tier assignment dispute-proof:
 *   - The customer sees the MRR breakdown + tier + price before any charge.
 *   - The subscription is created only after they explicitly click subscribe.
 *   - There is no fire-and-forget path from webhook to charge.
 *
 * Carve-outs (preserved):
 *   - pilotUntil > now() → prepareActivation returns 'pilot', no card prompt,
 *     no subscription. Snapshots still take so recommended_tier is hot when
 *     the pilot ends.
 *   - customMonthlyCents != null → tier is 'custom', priceUsdMinor is the
 *     negotiated amount. Activation page surfaces the amount; commitActivation
 *     creates a one-off Price (handled by ensurePlatformSubscription).
 *
 * Enterprise short-circuit:
 *   - If the live MRR puts the customer in the enterprise band, set
 *     requires_sales = true, emit an internal alert, return
 *     'enterprise_handoff'. The activation page renders a "contact sales"
 *     state — no Subscribe button, no card prompt.
 */

export type PrepareActivationState =
  | { state: 'no_op' }
  | { state: 'pilot'; pilotUntil: Date | null }
  | { state: 'enterprise_handoff'; mrrUsdMinor: number; mrrBreakdown: MrrBreakdown }
  | {
      state: 'awaiting_confirmation'
      tier: TierKey | 'custom'
      tierLabel: string
      priceUsdMinor: number
      mrrUsdMinor: number
      perCurrency: MrrPerCurrency
      mrrBreakdown: MrrBreakdown
      activatedAt: Date
    }

export type CommitActivationState =
  | { state: 'no_op' }
  | { state: 'pilot'; pilotUntil: Date | null }
  | { state: 'awaiting_card'; activatedAt: Date }
  | { state: 'tier_mismatch'; recommendedTier: TierKey | 'custom' | null }
  | { state: 'enterprise_handoff' }
  | {
      state: 'active'
      subscriptionId: string
      subscriptionCreated: boolean
    }

/**
 * Phase A — compute & persist the activation decision. Never creates a
 * Stripe subscription. Idempotent on re-call: re-reads live MRR each time
 * (so a customer who reloads the activation page after their MRR shifted
 * sees the new figure), but only re-marks activatedAt if it's still NULL.
 */
export async function prepareActivation(
  wbCustomerId: string,
): Promise<PrepareActivationState> {
  const [cust] = await db
    .select({
      id: customers.id,
      activatedAt: customers.activatedAt,
    })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  if (!cust) throw new Error(`wb_customer ${wbCustomerId} not found`)

  const deliveriesExist = await hasAnyDelivery(wbCustomerId)
  if (!deliveriesExist) return { state: 'no_op' }

  if (await isCustomerOnPilot(wbCustomerId)) {
    const pilotUntil = await getPilotUntil(wbCustomerId)
    await logEvent({
      name: 'platform_billing_skipped_pilot',
      customerId: wbCustomerId,
      properties: { pilotUntil: pilotUntil?.toISOString() ?? null },
    })
    return { state: 'pilot', pilotUntil }
  }

  // Mark activatedAt on first qualifying delivery, even if subscription
  // creation still has gates to clear. Conditional UPDATE so concurrent
  // calls don't trample each other.
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
      // Trial-complete email — fire-and-forget. Skips internally if pilot.
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
        console.error('[activation] failed to send trial-complete email', err),
      )
    } else {
      const [latest] = await db
        .select({ activatedAt: customers.activatedAt })
        .from(customers)
        .where(eq(customers.id, wbCustomerId))
        .limit(1)
      activatedAt = latest?.activatedAt ?? now
    }
  }

  // Custom flat-rate carve-out: skip tier computation entirely.
  const flatRateCents = await getCustomMonthlyCents(wbCustomerId)
  if (flatRateCents !== null) {
    await db
      .update(customers)
      .set({
        recommendedTier: 'custom',
        recommendedChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(customers.id, wbCustomerId))

    // We don't have an MRR figure for the activation breakdown UI when the
    // customer is on a custom rate (tier ladder bypassed). Run a snapshot
    // anyway for analytics, but the UI shows the custom price directly.
    const snap = await takeSnapshot(wbCustomerId, 'activation_live_read')
    return {
      state: 'awaiting_confirmation',
      tier: 'custom',
      tierLabel: 'Custom plan',
      priceUsdMinor: flatRateCents,
      mrrUsdMinor: snap.ok ? snap.mrrUsdMinor : 0,
      perCurrency: snap.ok ? snap.perCurrency : {},
      mrrBreakdown: snap.ok
        ? snap.breakdown
        : {
            activeSubscriptionCount: 0,
            pastDueSubscriptionCount: 0,
            excludedTrialingCount: 0,
            excludedCanceledCount: 0,
            excludedOtherCount: 0,
            skippedMissingFxCount: 0,
            skippedMeteredCount: 0,
          },
      activatedAt: activatedAt as Date,
    }
  }

  // Standard tier flow: live Stripe read → tier → persist.
  const snap = await takeSnapshot(wbCustomerId, 'activation_live_read')
  if (!snap.ok) {
    // Stripe API error or missing token. Defensive: report no_op so the
    // UI keeps the "awaiting" state and a future retry resolves it.
    // The snapshot path already logged the error.
    return { state: 'no_op' }
  }

  const recommended = tierFromMrr(snap.mrrUsdMinor, { biasLow: true })

  if (recommended === 'enterprise') {
    const now = new Date()
    await db
      .update(customers)
      .set({
        recommendedTier: 'enterprise',
        recommendedChangedAt: now,
        requiresSales: true,
        smoothedMrrUsdMinor: snap.mrrUsdMinor,
        smoothedMrrComputedAt: now,
        updatedAt: now,
      })
      .where(eq(customers.id, wbCustomerId))
    await emitInternalAlert({
      severity: 'info',
      title: 'Enterprise customer detected at activation',
      details: {
        customerId: wbCustomerId,
        mrrUsdMinor: snap.mrrUsdMinor,
        mrrUsd: snap.mrrUsdMinor / 100,
      },
    })
    return {
      state: 'enterprise_handoff',
      mrrUsdMinor: snap.mrrUsdMinor,
      mrrBreakdown: snap.breakdown,
    }
  }

  const cfg = tierConfig(recommended)
  const now = new Date()
  await db
    .update(customers)
    .set({
      recommendedTier: recommended,
      recommendedChangedAt: now,
      smoothedMrrUsdMinor: snap.mrrUsdMinor,
      smoothedMrrComputedAt: now,
      updatedAt: now,
    })
    .where(eq(customers.id, wbCustomerId))

  return {
    state: 'awaiting_confirmation',
    tier: recommended,
    tierLabel: tierLabel(recommended),
    priceUsdMinor: cfg.priceUsdMinor as number,
    mrrUsdMinor: snap.mrrUsdMinor,
    perCurrency: snap.perCurrency,
    mrrBreakdown: snap.breakdown,
    activatedAt: activatedAt as Date,
  }
}

/**
 * Phase B — commit the subscription at the customer-confirmed tier.
 *
 * Fired by POST /api/billing/activate after the customer clicks the
 * "Subscribe at $X/mo" button on the activation page. `confirmedTier` is
 * the tier they saw on screen.
 *
 * Re-validation:
 *   - If recommendedTier has drifted from confirmedTier between page load
 *     and click (rare — the snapshot cron only runs weekly, and webhook-
 *     driven recomputes are async), refuse to proceed and ask the UI to
 *     refresh. The customer is never billed at a tier they didn't see.
 *
 * Carve-outs:
 *   - Pilot active → no-op (mirror of prepareActivation).
 *   - Enterprise recommended → refuse (sales handles this).
 *   - customMonthlyCents set → ignore confirmedTier; use the custom Price
 *     (route via ensurePlatformSubscription which is already custom-rate
 *     aware).
 *
 * Card check:
 *   - No card on file → return awaiting_card. The activation page handles
 *     the Stripe Checkout setup-mode redirect; on return, this endpoint is
 *     re-called.
 */
export async function commitActivation(
  wbCustomerId: string,
  confirmedTier: TierKey | 'custom',
): Promise<CommitActivationState> {
  const [cust] = await db
    .select({
      id: customers.id,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
      recommendedTier: customers.recommendedTier,
      activatedAt: customers.activatedAt,
    })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  if (!cust) throw new Error(`wb_customer ${wbCustomerId} not found`)

  const deliveriesExist = await hasAnyDelivery(wbCustomerId)
  if (!deliveriesExist) return { state: 'no_op' }

  if (await isCustomerOnPilot(wbCustomerId)) {
    const pilotUntil = await getPilotUntil(wbCustomerId)
    return { state: 'pilot', pilotUntil }
  }

  const flatRateCents = await getCustomMonthlyCents(wbCustomerId)
  const effectiveRecommended =
    flatRateCents !== null ? 'custom' : (cust.recommendedTier as TierKey | 'custom' | null)

  if (effectiveRecommended === 'enterprise') {
    return { state: 'enterprise_handoff' }
  }

  if (effectiveRecommended !== confirmedTier) {
    return { state: 'tier_mismatch', recommendedTier: effectiveRecommended }
  }

  const platformCustomerId =
    cust.stripePlatformCustomerId ?? (await getOrCreatePlatformCustomer(wbCustomerId))

  const cardOnFile = await getCurrentDefaultPaymentMethodId(platformCustomerId)
  if (!cardOnFile) {
    return { state: 'awaiting_card', activatedAt: cust.activatedAt as Date }
  }

  // ensurePlatformSubscription is now tier-aware. For custom rates it
  // ignores the tier arg internally and uses the custom Price.
  const tierForSub: TierKey | undefined =
    confirmedTier === 'custom' ? undefined : confirmedTier
  const { subscriptionId, created } = await ensurePlatformSubscription(
    wbCustomerId,
    tierForSub,
  )

  return {
    state: 'active',
    subscriptionId,
    subscriptionCreated: created,
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


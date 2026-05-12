import type Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { eq, and, or, isNull, lt } from 'drizzle-orm'
import { getPlatformStripe } from './platform-stripe'
import { getInvoiceLineInvoiceItemId } from './stripe'
import { PLATFORM_FEE_CURRENCY } from './subscription'
import { isCustomerOnPilot } from './pilot'
import { logEvent } from './events'

/**
 * Spec 58 — TTL for the perf-fee creation lock.
 *
 * Wide enough to comfortably cover one stripe.invoiceItems.create call
 * (~200-500ms typical) plus the follow-up UPDATE. After this window a
 * caller's claim is considered stale and the next caller can reclaim
 * it (crash recovery). Mirrors the SUBSCRIPTION_CREATION_LOCK_TTL_MS
 * in subscription.ts.
 */
const PERF_FEE_CREATING_LOCK_TTL_MS = 30_000

/**
 * Phase A — Performance-fee charging and refunding.
 *
 * The performance fee is 1× MRR per voluntary-cancellation win-back, charged
 * once and refundable in full if the subscriber re-cancels within 14 days.
 * It rides on the customer's existing Stripe Subscription as a one-off
 * invoice item, attached to the subscription so it lands on the next
 * cycle's invoice automatically.
 *
 * Idempotency: every operation keys off `wb_recoveries.perf_fee_stripe_item_id`.
 * Charge is no-op if the column is set; refund decides between item deletion
 * and credit notes by inspecting the invoice item's current state in Stripe.
 */

export const PERF_FEE_REFUND_WINDOW_DAYS = 14

interface RecoveryRow {
  id: string
  subscriberId: string
  customerId: string
  planMrrCents: number
  recoveryType: string | null
  perfFeeStripeItemId: string | null
  perfFeeChargedAt: Date | null
  perfFeeRefundedAt: Date | null
}

interface CustomerRow {
  stripePlatformCustomerId: string | null
  stripeSubscriptionId: string | null
}

async function loadRecovery(recoveryId: string): Promise<RecoveryRow | null> {
  const [row] = await db
    .select({
      id: recoveries.id,
      subscriberId: recoveries.subscriberId,
      customerId: recoveries.customerId,
      planMrrCents: recoveries.planMrrCents,
      recoveryType: recoveries.recoveryType,
      perfFeeStripeItemId: recoveries.perfFeeStripeItemId,
      perfFeeChargedAt: recoveries.perfFeeChargedAt,
      perfFeeRefundedAt: recoveries.perfFeeRefundedAt,
    })
    .from(recoveries)
    .where(eq(recoveries.id, recoveryId))
    .limit(1)
  return row ?? null
}

async function loadCustomerBilling(customerId: string): Promise<CustomerRow | null> {
  const [row] = await db
    .select({
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
      stripeSubscriptionId: customers.stripeSubscriptionId,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)
  return row ?? null
}

async function loadSubscriberEmail(subscriberId: string): Promise<string> {
  const [row] = await db
    .select({ email: churnedSubscribers.email })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  return row?.email ?? 'unknown'
}

/**
 * Charges the 1× MRR performance fee for a strong-attribution win-back
 * recovery as a Stripe invoice item.
 *
 * Two paths:
 *   • Subscription exists → invoice item is attached to that subscription
 *     and lands on the next cycle's invoice.
 *   • No subscription yet → invoice item is created as PENDING (no
 *     `subscription` field). The next time a subscription invoice is
 *     generated for this customer (typically in `ensurePlatformSubscription`
 *     immediately after this call), Stripe bundles the pending items onto
 *     that first invoice automatically. This is how the prorated $99 plus
 *     all win-back fees end up on a single first invoice.
 *
 * Preconditions:
 *   • Recovery must exist and have `recoveryType = 'win_back'`.
 *   • Customer must have a platform Stripe customer.
 *   • If `perfFeeStripeItemId` is already set on the recovery, this is a no-op.
 */
export async function chargePerformanceFee(recoveryId: string): Promise<{
  invoiceItemId: string | null
  amountCents: number
  alreadyCharged: boolean
  skipped?: 'pilot' | 'race'
}> {
  const rec = await loadRecovery(recoveryId)
  if (!rec) throw new Error(`recovery ${recoveryId} not found`)
  if (rec.recoveryType !== 'win_back') {
    throw new Error(
      `recovery ${recoveryId} is not a win-back (recoveryType=${rec.recoveryType})`,
    )
  }
  if (rec.perfFeeStripeItemId) {
    return {
      invoiceItemId: rec.perfFeeStripeItemId,
      amountCents: rec.planMrrCents,
      alreadyCharged: true,
    }
  }

  // Spec 31 — pilot bypass. While pilot_until > now() we don't create the
  // Stripe invoice item; we log the would-have-charged amount in
  // skippedAmountCents so the comp value of the pilot is auditable.
  // Note: we DON'T set perfFeeStripeItemId here, so if the pilot graduates
  // and the same recovery is retried, the fee will charge normally.
  if (await isCustomerOnPilot(rec.customerId)) {
    await logEvent({
      name: 'performance_fee_skipped_pilot',
      customerId: rec.customerId,
      properties: {
        recoveryId,
        skippedAmountCents: rec.planMrrCents,
      },
    })
    return {
      invoiceItemId: null,
      amountCents: rec.planMrrCents,
      alreadyCharged: false,
      skipped: 'pilot',
    }
  }

  // Spec 58 — atomic claim. Two concurrent ensureActivation calls (the
  // Subscribe-flow Spec 52 scenario: /billing/success + the
  // checkout.session.completed webhook) both reach this point with the
  // same recovery, perfFeeStripeItemId still NULL. Without this fence,
  // both would call stripe.invoiceItems.create and the customer would be
  // billed twice (the DB UPDATE that writes perfFeeStripeItemId is a
  // last-writer-wins, but the Stripe items both exist). The conditional
  // UPDATE serializes them: Postgres returns a row to exactly one caller;
  // the loser sees `claimed.length === 0` and short-circuits.
  const claimStaleCutoff = new Date(Date.now() - PERF_FEE_CREATING_LOCK_TTL_MS)
  const claimed = await db
    .update(recoveries)
    .set({ perfFeeCreatingAt: new Date() })
    .where(and(
      eq(recoveries.id, recoveryId),
      isNull(recoveries.perfFeeStripeItemId),
      or(
        isNull(recoveries.perfFeeCreatingAt),
        lt(recoveries.perfFeeCreatingAt, claimStaleCutoff),
      ),
    ))
    .returning({ id: recoveries.id })

  if (claimed.length === 0) {
    // Another caller has the lock (or has just finished). Re-read once
    // — if the lock-holder completed, return their item id as
    // alreadyCharged. Otherwise log and back out; the holder will
    // complete the work for us.
    const fresh = await loadRecovery(recoveryId)
    if (fresh?.perfFeeStripeItemId) {
      return {
        invoiceItemId: fresh.perfFeeStripeItemId,
        amountCents: rec.planMrrCents,
        alreadyCharged: true,
      }
    }
    await logEvent({
      name: 'perf_fee_create_skipped_race',
      customerId: rec.customerId,
      properties: { recoveryId },
    })
    return {
      invoiceItemId: null,
      amountCents: rec.planMrrCents,
      alreadyCharged: false,
      skipped: 'race',
    }
  }

  const cust = await loadCustomerBilling(rec.customerId)
  if (!cust?.stripePlatformCustomerId) {
    // Release the lock before throwing so retries aren't blocked.
    await db
      .update(recoveries)
      .set({ perfFeeCreatingAt: null })
      .where(eq(recoveries.id, recoveryId))
    throw new Error(`customer ${rec.customerId} has no platform Stripe customer`)
  }

  const email = await loadSubscriberEmail(rec.subscriberId)
  const stripe = getPlatformStripe()

  const params: Stripe.InvoiceItemCreateParams = {
    customer: cust.stripePlatformCustomerId,
    amount: rec.planMrrCents,
    currency: PLATFORM_FEE_CURRENCY,
    description: `Win-back: ${email}`,
    metadata: {
      winback_recovery_id: recoveryId,
      winback_customer_id: rec.customerId,
    },
  }
  // When a subscription is already live, attach the item to it so it lands
  // on the next cycle's invoice. Otherwise leave it pending so Stripe picks
  // it up onto the very first subscription invoice (the activation case).
  if (cust.stripeSubscriptionId) {
    params.subscription = cust.stripeSubscriptionId
  }

  let item: Stripe.InvoiceItem
  try {
    // Spec 58 — Stripe Idempotency-Key is the belt to the DB fence's
    // suspenders. Per-recovery key is natural (one perf fee per recovery,
    // ever). If the DB lock ever leaks (refactor regression, weird Postgres
    // edge case), Stripe will dedup by key for 24h and return the same
    // invoice item id rather than billing twice.
    item = await stripe.invoiceItems.create(params, {
      idempotencyKey: `wb-perf-${recoveryId}`,
    })
  } catch (err) {
    // Release the lock so the next caller (or a retry) isn't blocked
    // for 30s waiting for the TTL.
    await db
      .update(recoveries)
      .set({ perfFeeCreatingAt: null })
      .where(eq(recoveries.id, recoveryId))
    throw err
  }

  // Atomic: write the item id AND clear the lock in one UPDATE. Once this
  // returns, future callers reading the row will see perfFeeStripeItemId
  // set and short-circuit at the top of the function.
  await db
    .update(recoveries)
    .set({
      perfFeeStripeItemId: item.id,
      perfFeeAmountCents: rec.planMrrCents,
      perfFeeChargedAt: new Date(),
      perfFeeCreatingAt: null,
    })
    .where(eq(recoveries.id, recoveryId))

  return { invoiceItemId: item.id, amountCents: rec.planMrrCents, alreadyCharged: false }
}

/**
 * Refunds a previously-charged performance fee. Used when a recovered
 * subscriber re-cancels within the 14-day refund window.
 *
 * Strategy:
 *   • If the invoice item has not yet been attached to an invoice, or the
 *     invoice is still in `draft`, delete the item — it never bills.
 *   • If the invoice is finalized (`open` / `paid` / `uncollectible`), issue
 *     a Stripe credit note against the matching line item, refunding the
 *     amount in full.
 *
 * Idempotency: no-op if `perfFeeRefundedAt` is already set.
 */
export async function refundPerformanceFee(recoveryId: string): Promise<{
  method: 'delete_item' | 'credit_note' | 'line_not_found' | 'noop'
}> {
  const rec = await loadRecovery(recoveryId)
  if (!rec) throw new Error(`recovery ${recoveryId} not found`)
  if (rec.perfFeeRefundedAt) return { method: 'noop' }
  if (!rec.perfFeeStripeItemId) {
    // Charge never happened (or pre-card-capture). Just mark refunded so
    // we don't try to charge it later, and exit cleanly.
    await db
      .update(recoveries)
      .set({ perfFeeRefundedAt: new Date() })
      .where(eq(recoveries.id, recoveryId))
    return { method: 'noop' }
  }

  const stripe = getPlatformStripe()
  const item = await stripe.invoiceItems.retrieve(rec.perfFeeStripeItemId)
  const invoiceId = typeof item.invoice === 'string' ? item.invoice : item.invoice?.id ?? null

  let method: 'delete_item' | 'credit_note' | 'line_not_found'

  if (!invoiceId) {
    // Pending — never attached to an invoice. Clean removal.
    await stripe.invoiceItems.del(rec.perfFeeStripeItemId)
    method = 'delete_item'
  } else {
    const invoice = await stripe.invoices.retrieve(invoiceId)
    if (invoice.status === 'draft') {
      await stripe.invoiceItems.del(rec.perfFeeStripeItemId)
      method = 'delete_item'
    } else {
      // Spec 61 — `line.invoice_item` was moved to
      // `line.parent.invoice_item_details.invoice_item` in Stripe API
      // ≥ 2024-09-30. Helper handles both shapes.
      const line = invoice.lines.data.find(
        (l) => getInvoiceLineInvoiceItemId(l) === rec.perfFeeStripeItemId,
      )
      if (!line) {
        // Phase D — graceful no-line path. Most likely causes: invoice line
        // expansion was paginated and we got an incomplete window, the
        // invoice was modified manually in the dashboard, or Stripe's
        // line-attachment lagged behind the item. Don't permanently 500
        // the webhook (Stripe would retry forever); mark refunded locally
        // and emit an admin event for manual reconciliation.
        logEvent({
          name: 'win_back_refund_line_missing',
          customerId: rec.customerId,
          properties: {
            recoveryId,
            invoiceId,
            invoiceItemId: rec.perfFeeStripeItemId,
            invoiceStatus: invoice.status,
          },
        })
        method = 'line_not_found'
      } else {
        // Spec 61 — Stripe API requires that the credit note's total
        // (sum of line amounts) equal `refund_amount + credit_amount +
        // out_of_band_amount`. We pass refund_amount = perf fee amount
        // so Stripe issues a real refund back to the merchant's card
        // alongside the credit note. Semantically: "the win-back didn't
        // stick — give the merchant their perf fee back."
        await stripe.creditNotes.create({
          invoice: invoiceId,
          lines: [
            { type: 'invoice_line_item', invoice_line_item: line.id, quantity: 1 },
          ],
          refund_amount: rec.planMrrCents,
        })
        method = 'credit_note'
      }
    }
  }

  await db
    .update(recoveries)
    .set({ perfFeeRefundedAt: new Date() })
    .where(eq(recoveries.id, recoveryId))

  return { method }
}

/**
 * Charges performance fees for any pending win-back recoveries that haven't
 * been billed yet for this customer. Used by the activation flow when a card
 * is captured after one or more win-backs already happened (the win-backs
 * accrue in the DB until billing infrastructure exists).
 */
export async function chargePendingPerformanceFees(
  customerId: string,
): Promise<{ chargedRecoveryIds: string[] }> {
  const pending = await db
    .select({ id: recoveries.id })
    .from(recoveries)
    .where(
      and(
        eq(recoveries.customerId, customerId),
        eq(recoveries.recoveryType, 'win_back'),
        isNull(recoveries.perfFeeChargedAt),
      ),
    )

  const chargedRecoveryIds: string[] = []
  for (const row of pending) {
    await chargePerformanceFee(row.id)
    chargedRecoveryIds.push(row.id)
  }
  return { chargedRecoveryIds }
}

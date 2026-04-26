import type Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { getPlatformStripe } from './platform-stripe'
import { PLATFORM_FEE_CURRENCY } from './subscription'

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
 * recovery as a Stripe invoice item attached to the customer's subscription.
 *
 * Preconditions:
 *   • Recovery must exist and have `recoveryType = 'win_back'`.
 *   • Customer must have an active Stripe Subscription (`stripeSubscriptionId`).
 *   • If `perfFeeStripeItemId` is already set on the recovery, this is a no-op.
 *
 * The created invoice item rides the next subscription invoice cycle.
 */
export async function chargePerformanceFee(recoveryId: string): Promise<{
  invoiceItemId: string
  amountCents: number
  alreadyCharged: boolean
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

  const cust = await loadCustomerBilling(rec.customerId)
  if (!cust?.stripePlatformCustomerId) {
    throw new Error(`customer ${rec.customerId} has no platform Stripe customer`)
  }
  if (!cust.stripeSubscriptionId) {
    throw new Error(
      `customer ${rec.customerId} has no active subscription — call ensurePlatformSubscription first`,
    )
  }

  const email = await loadSubscriberEmail(rec.subscriberId)
  const stripe = getPlatformStripe()

  const item = await stripe.invoiceItems.create({
    customer: cust.stripePlatformCustomerId,
    subscription: cust.stripeSubscriptionId,
    amount: rec.planMrrCents,
    currency: PLATFORM_FEE_CURRENCY,
    description: `Win-back: ${email}`,
    metadata: {
      winback_recovery_id: recoveryId,
      winback_customer_id: rec.customerId,
    },
  })

  await db
    .update(recoveries)
    .set({
      perfFeeStripeItemId: item.id,
      perfFeeAmountCents: rec.planMrrCents,
      perfFeeChargedAt: new Date(),
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
  method: 'delete_item' | 'credit_note' | 'noop'
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

  let method: 'delete_item' | 'credit_note'

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
      const line = invoice.lines.data.find(
        (l) => (l as Stripe.InvoiceLineItem & { invoice_item?: string }).invoice_item ===
          rec.perfFeeStripeItemId,
      )
      if (!line) {
        throw new Error(
          `cannot find invoice line for item ${rec.perfFeeStripeItemId} on invoice ${invoiceId}`,
        )
      }
      await stripe.creditNotes.create({
        invoice: invoiceId,
        lines: [
          { type: 'invoice_line_item', invoice_line_item: line.id, quantity: 1 },
        ],
      })
      method = 'credit_note'
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

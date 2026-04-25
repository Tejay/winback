import { db } from '@/lib/db'
import { recoveries, churnedSubscribers } from '@/lib/schema'
import { eq, and, gt } from 'drizzle-orm'
import { BILLABLE_ATTRIBUTION, SUCCESS_FEE_RATE as BILLING_RATE } from './obligations'

export interface MonthlyFee {
  recoveredMrrActiveCents: number
  successFeeCents:         number
  totalFeeCents:           number
  recoveredSubscribers: Array<{
    recoveryId:   string    // Spec 24a — needed for invoice line-item metadata
    subscriberId: string
    email:        string
    mrrCents:     number
    feeCents:     number    // 15% × mrrCents, rounded — the per-line-item amount
    recoveredAt:  Date
    stillActive:  boolean
  }>
}

// Pricing: 15% of recovered MRR, 12-month attribution per subscriber.
// No base fee, no cap.
//
// We only bill recoveries with `attributionType = BILLABLE_ATTRIBUTION`
// (currently 'strong' — the subscriber clicked a tracked Winback link).
// "Weak" recoveries are shown in the dashboard but never invoiced — see
// `obligations.ts` for the policy and `/faq` for the founder-facing
// explanation. The attribution window (12 months) is enforced by the
// `attributionEndsAt` filter below — rows past that date fall out
// of the billed set automatically.
const SUCCESS_FEE_RATE = BILLING_RATE

export async function calculateMonthlyFee(customerId: string): Promise<MonthlyFee> {
  const now = new Date()

  // Get all billable recoveries where attribution hasn't expired
  const activeRecoveries = await db
    .select()
    .from(recoveries)
    .where(
      and(
        eq(recoveries.customerId, customerId),
        eq(recoveries.stillActive, true),
        eq(recoveries.attributionType, BILLABLE_ATTRIBUTION),
        gt(recoveries.attributionEndsAt, now)
      )
    )

  const recoveredSubscribersList: MonthlyFee['recoveredSubscribers'] = []
  let recoveredMrrActiveCents = 0

  for (const rec of activeRecoveries) {
    const [sub] = await db
      .select({ email: churnedSubscribers.email })
      .from(churnedSubscribers)
      .where(eq(churnedSubscribers.id, rec.subscriberId))
      .limit(1)

    recoveredMrrActiveCents += rec.planMrrCents

    recoveredSubscribersList.push({
      recoveryId: rec.id,
      subscriberId: rec.subscriberId,
      email: sub?.email ?? 'unknown',
      mrrCents: rec.planMrrCents,
      feeCents: Math.round(rec.planMrrCents * SUCCESS_FEE_RATE),
      recoveredAt: rec.recoveredAt ?? new Date(),
      stillActive: true,
    })
  }

  const successFeeCents = Math.round(recoveredMrrActiveCents * SUCCESS_FEE_RATE)
  const totalFeeCents = successFeeCents

  return {
    recoveredMrrActiveCents,
    successFeeCents,
    totalFeeCents,
    recoveredSubscribers: recoveredSubscribersList,
  }
}

// ============================================================================
// Spec 26 — single-customer billing run (extracted from app/api/cron/billing
// so the admin "retry failed invoice" action can reuse the exact same logic).
// ============================================================================

import { customers, billingRuns } from '@/lib/schema'
import { getPlatformStripe } from './platform-stripe'
import { humanPeriod } from './platform-billing'
import { logEvent } from './events'

export interface BillingRunResult {
  outcome: 'created' | 'skipped_no_card' | 'skipped_no_obligations' | 'already_billed' | 'error'
  billingRunId?: string
  stripeInvoiceId?: string
  amountCents?: number
  errorMessage?: string
}

/**
 * Run the billing flow for a single (customer, period) pair. Used by:
 *   - the monthly cron loop (called once per candidate customer)
 *   - the admin retry endpoint (called when a failed run needs to be re-attempted)
 *
 * Idempotency: relies on UNIQUE(customer_id, period_yyyymm) on wb_billing_runs.
 * If `isRetry` is true and a row already exists, we update it; otherwise we
 * insert. Paid runs are never overwritten — the function returns
 * `already_billed` if the row exists with a non-failed/non-pending status.
 */
export async function processBillingRun(
  customerId: string,
  period: string,
  opts: { isRetry?: boolean } = {},
): Promise<BillingRunResult> {
  const stripe = getPlatformStripe()

  // 1. Load customer (need stripe_platform_customer_id for invoice creation).
  const [cust] = await db
    .select({
      id: customers.id,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
    })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)

  if (!cust) {
    return { outcome: 'error', errorMessage: 'customer not found' }
  }

  // 2. Idempotency check / retry logic.
  const [existing] = await db
    .select({ id: billingRuns.id, status: billingRuns.status })
    .from(billingRuns)
    .where(and(
      eq(billingRuns.customerId, customerId),
      eq(billingRuns.periodYyyymm, period),
    ))
    .limit(1)

  if (existing) {
    if (!opts.isRetry) {
      return { outcome: 'already_billed', billingRunId: existing.id }
    }
    if (existing.status !== 'failed' && existing.status !== 'pending') {
      // Don't overwrite a paid or skipped run — that would risk double-billing.
      return { outcome: 'already_billed', billingRunId: existing.id }
    }
  }

  // 3. No card on file → record skip + return.
  const platformCustomerId = cust.stripePlatformCustomerId
  if (!platformCustomerId) {
    if (existing) {
      await db.update(billingRuns)
        .set({ status: 'skipped_no_card', amountCents: 0, lineItemCount: 0 })
        .where(eq(billingRuns.id, existing.id))
    } else {
      await db.insert(billingRuns).values({
        customerId, periodYyyymm: period, status: 'skipped_no_card',
      })
    }
    return { outcome: 'skipped_no_card' }
  }

  // 4. Calculate fee. No obligations → record skip + return.
  const fee = await calculateMonthlyFee(customerId)
  if (fee.totalFeeCents === 0) {
    if (existing) {
      await db.update(billingRuns)
        .set({ status: 'skipped_no_obligations', amountCents: 0, lineItemCount: 0 })
        .where(eq(billingRuns.id, existing.id))
    } else {
      await db.insert(billingRuns).values({
        customerId, periodYyyymm: period, status: 'skipped_no_obligations', lineItemCount: 0,
      })
    }
    return { outcome: 'skipped_no_obligations' }
  }

  // 5. Reserve the run row as `pending` BEFORE Stripe — keeps an audit trail
  //    if Stripe fails midway.
  let runId: string
  if (existing) {
    await db.update(billingRuns)
      .set({
        status: 'pending',
        stripeInvoiceId: null,  // clear stale invoice id from a prior failed attempt
        amountCents: 0,
        lineItemCount: fee.recoveredSubscribers.length,
      })
      .where(eq(billingRuns.id, existing.id))
    runId = existing.id
  } else {
    const [run] = await db.insert(billingRuns).values({
      customerId,
      periodYyyymm: period,
      status: 'pending',
      lineItemCount: fee.recoveredSubscribers.length,
    }).returning({ id: billingRuns.id })
    runId = run.id
  }

  // 6. Stripe — create line items + invoice + finalize. Wrap in try/catch
  //    so a Stripe failure marks the run failed instead of leaving it pending.
  try {
    for (const item of fee.recoveredSubscribers) {
      await stripe.invoiceItems.create({
        customer: platformCustomerId,
        amount: item.feeCents,
        currency: 'usd',
        description: `Recovered: ${item.email} — $${(item.mrrCents / 100).toFixed(2)}/mo (15%)`,
        metadata: {
          winback_customer_id: customerId,
          winback_recovery_id: item.recoveryId,
          period_yyyymm: period,
        },
      })
    }

    const draftInvoice = await stripe.invoices.create({
      customer: platformCustomerId,
      auto_advance: false,
      collection_method: 'charge_automatically',
      pending_invoice_items_behavior: 'include',
      description: `Winback success fees — ${humanPeriod(period)}`,
      metadata: {
        winback_customer_id: customerId,
        winback_billing_run_id: runId,
        period_yyyymm: period,
      },
    })

    if (!draftInvoice.id) throw new Error('Stripe invoice.create returned no id')

    const invoice = await stripe.invoices.finalizeInvoice(draftInvoice.id, {
      auto_advance: true,
    })

    await db.update(billingRuns)
      .set({
        stripeInvoiceId: invoice.id,
        amountCents: invoice.amount_due,
        finalizedAt: new Date(),
      })
      .where(eq(billingRuns.id, runId))

    await logEvent({
      name: 'billing_invoice_created',
      customerId,
      properties: {
        billingRunId: runId,
        stripeInvoiceId: invoice.id,
        amountCents: invoice.amount_due,
        lineItemCount: fee.recoveredSubscribers.length,
        period,
        retry: !!opts.isRetry,
      },
    })

    return {
      outcome: 'created',
      billingRunId: runId,
      stripeInvoiceId: invoice.id ?? undefined,
      amountCents: invoice.amount_due,
    }
  } catch (err) {
    // Mark the run failed so the admin UI shows it for retry.
    await db.update(billingRuns)
      .set({ status: 'failed' })
      .where(eq(billingRuns.id, runId))

    await logEvent({
      name: 'billing_invoice_failed',
      customerId,
      properties: {
        billingRunId: runId,
        period,
        retry: !!opts.isRetry,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    })

    return {
      outcome: 'error',
      billingRunId: runId,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }
}

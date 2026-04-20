import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers, billingRuns } from '@/lib/schema'
import { eq, and, isNotNull } from 'drizzle-orm'
import { getPlatformStripe } from '@/src/winback/lib/platform-stripe'
import { previousMonthYYYYMM, humanPeriod } from '@/src/winback/lib/platform-billing'
import { calculateMonthlyFee } from '@/src/winback/lib/billing'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 24a — Monthly invoice cron.
 *
 * Runs via Vercel cron on the 1st of each month at 00:00 UTC. Bills in
 * arrears: on June 1st we invoice for recoveries active during May.
 *
 * For each customer:
 *   1. Skip if already billed for this period (unique constraint + early check)
 *   2. Skip if no card on file (status='skipped_no_card')
 *   3. Skip if no billable obligations (status='skipped_no_obligations')
 *   4. Otherwise: create Stripe invoice items per recovery → create invoice
 *      → auto-finalize (auto_advance: true) → Stripe attempts payment on default PM
 *
 * The `wb_billing_runs` table provides idempotency + audit. Payment
 * status is updated async via the invoice.paid / invoice.payment_failed
 * webhooks (see app/api/stripe/webhook/route.ts).
 */
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const period = previousMonthYYYYMM()
  const stripe = getPlatformStripe()

  // Candidate customers: any with a platform Stripe customer (has been
  // billable at some point). We can narrow further, but this is fine for now.
  const candidates = await db
    .select({
      id: customers.id,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
    })
    .from(customers)
    .where(isNotNull(customers.stripePlatformCustomerId))

  let processed = 0
  let created = 0
  let skipped = 0
  let errors = 0

  for (const cust of candidates) {
    processed++
    try {
      // Idempotency — skip if a run already exists for this period.
      const existing = await db
        .select({ id: billingRuns.id })
        .from(billingRuns)
        .where(and(
          eq(billingRuns.customerId, cust.id),
          eq(billingRuns.periodYyyymm, period),
        ))
        .limit(1)
      if (existing.length > 0) {
        skipped++
        continue
      }

      const platformCustomerId = cust.stripePlatformCustomerId
      if (!platformCustomerId) {
        // Shouldn't happen (we filtered above) but defensive:
        await db.insert(billingRuns).values({
          customerId: cust.id,
          periodYyyymm: period,
          status: 'skipped_no_card',
        })
        skipped++
        continue
      }

      const fee = await calculateMonthlyFee(cust.id)
      if (fee.totalFeeCents === 0) {
        await db.insert(billingRuns).values({
          customerId: cust.id,
          periodYyyymm: period,
          status: 'skipped_no_obligations',
          lineItemCount: 0,
        })
        skipped++
        continue
      }

      // Reserve the period slot BEFORE hitting Stripe — if Stripe fails
      // we still have a row showing we attempted.
      const [run] = await db
        .insert(billingRuns)
        .values({
          customerId: cust.id,
          periodYyyymm: period,
          status: 'pending',
          lineItemCount: fee.recoveredSubscribers.length,
        })
        .returning({ id: billingRuns.id })

      // Create invoice items (each line = one billable recovery)
      for (const item of fee.recoveredSubscribers) {
        await stripe.invoiceItems.create({
          customer: platformCustomerId,
          amount: item.feeCents,
          currency: 'usd',
          description: `Recovered: ${item.email} — $${(item.mrrCents / 100).toFixed(2)}/mo (15%)`,
          metadata: {
            winback_customer_id: cust.id,
            winback_recovery_id: item.recoveryId,
            period_yyyymm: period,
          },
        })
      }

      // Create the invoice. pending_invoice_items_behavior: 'include'
      // pulls in the invoice items we just created (required in recent
      // Stripe API versions — default changed).
      const draftInvoice = await stripe.invoices.create({
        customer: platformCustomerId,
        auto_advance: false,  // we finalize explicitly below for immediate effect
        collection_method: 'charge_automatically',
        pending_invoice_items_behavior: 'include',
        description: `Winback success fees — ${humanPeriod(period)}`,
        metadata: {
          winback_customer_id: cust.id,
          winback_billing_run_id: run.id,
          period_yyyymm: period,
        },
      })

      if (!draftInvoice.id) {
        throw new Error('Stripe invoice.create returned no id')
      }

      // Finalize explicitly — this locks the invoice and triggers the
      // hosted URL + PDF. Without this, auto_advance=true would do the
      // same thing but with up to a 1-hour delay.
      const invoice = await stripe.invoices.finalizeInvoice(draftInvoice.id, {
        auto_advance: true,  // finalize then attempt payment on default PM
      })

      await db
        .update(billingRuns)
        .set({
          stripeInvoiceId: invoice.id,
          amountCents: invoice.amount_due,
          finalizedAt: new Date(),
        })
        .where(eq(billingRuns.id, run.id))

      logEvent({
        name: 'billing_invoice_created',
        customerId: cust.id,
        properties: {
          billingRunId: run.id,
          stripeInvoiceId: invoice.id,
          amountCents: invoice.amount_due,
          lineItemCount: fee.recoveredSubscribers.length,
          period,
        },
      })

      created++
    } catch (err) {
      errors++
      console.error(`[billing-cron] Failed for customer ${cust.id}:`, err)
      // Don't rethrow — continue with the next customer.
    }
  }

  logEvent({
    name: 'billing_cron_complete',
    properties: { period, processed, created, skipped, errors },
  })

  console.log(
    `[billing-cron] period=${period} processed=${processed} created=${created} skipped=${skipped} errors=${errors}`,
  )

  return NextResponse.json({ period, processed, created, skipped, errors })
}

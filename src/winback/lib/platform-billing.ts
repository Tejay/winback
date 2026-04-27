import type Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getPlatformStripe } from './platform-stripe'

// ─── Date/period helpers ─────────────────────────────────────────────────

/**
 * Human label for a YYYY-MM period. e.g. '2026-05' → 'May 2026'.
 */
export function humanPeriod(yyyymm: string): string {
  const [y, m] = yyyymm.split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) return yyyymm
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December']
  return `${months[m - 1]} ${y}`
}

/**
 * Spec 23 — Helpers for Winback's platform billing (charging founders
 * for their 15% success fees).
 */

export interface PaymentMethodSummary {
  id: string
  brand: string          // 'visa' | 'mastercard' | 'amex' | ...
  last4: string
  expMonth: number
  expYear: number
}

/**
 * Returns the platform Stripe customer ID for this wb_customer, creating
 * one on first call.
 *
 * Idempotent — safe to call multiple times. Only the first call makes a
 * network round-trip to Stripe; subsequent calls return the cached ID
 * from the DB.
 */
export async function getOrCreatePlatformCustomer(wbCustomerId: string): Promise<string> {
  const [row] = await db
    .select({
      id: customers.id,
      userId: customers.userId,
      founderName: customers.founderName,
      stripePlatformCustomerId: customers.stripePlatformCustomerId,
    })
    .from(customers)
    .where(eq(customers.id, wbCustomerId))
    .limit(1)

  if (!row) throw new Error(`wb_customer ${wbCustomerId} not found`)
  if (row.stripePlatformCustomerId) return row.stripePlatformCustomerId

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1)
  if (!user?.email) throw new Error(`user for wb_customer ${wbCustomerId} has no email`)

  const stripe = getPlatformStripe()
  const stripeCustomer = await stripe.customers.create({
    email: user.email,
    name: row.founderName ?? undefined,
    metadata: {
      winback_customer_id: wbCustomerId,
      winback_user_id: row.userId,
    },
  })

  await db
    .update(customers)
    .set({ stripePlatformCustomerId: stripeCustomer.id, updatedAt: new Date() })
    .where(eq(customers.id, wbCustomerId))

  return stripeCustomer.id
}

function summarize(pm: { id: string; card?: { brand: string; last4: string; exp_month: number; exp_year: number } | null }): PaymentMethodSummary | null {
  if (!pm.card) return null
  return {
    id: pm.id,
    brand: pm.card.brand,
    last4: pm.card.last4,
    expMonth: pm.card.exp_month,
    expYear: pm.card.exp_year,
  }
}

/**
 * Fetches the customer's payment method summary for display.
 * Returns null if no customer ID or no cards on file.
 *
 * Called from the Settings page server component on each render.
 *
 * Resilient to missing webhook events: if no default PM is set (which
 * happens in local dev without `stripe listen`, or if the webhook failed),
 * falls back to the most recently attached card and self-heals by setting
 * it as the default for future loads. This means the UI works regardless
 * of webhook delivery.
 */
export async function fetchPlatformPaymentMethod(
  platformCustomerId: string | null,
): Promise<PaymentMethodSummary | null> {
  if (!platformCustomerId) return null

  try {
    const stripe = getPlatformStripe()
    const customer = await stripe.customers.retrieve(platformCustomerId, {
      expand: ['invoice_settings.default_payment_method'],
    })

    if (typeof customer !== 'object' || customer.deleted) return null

    // Happy path: default PM is set (normal production flow where the
    // checkout.session.completed webhook fired)
    const defaultPm = customer.invoice_settings?.default_payment_method
    if (defaultPm && typeof defaultPm === 'object') {
      return summarize(defaultPm)
    }

    // Fallback: no default set, but cards may be attached. This happens in
    // local dev when webhooks don't reach localhost, or if the webhook
    // fails. List cards and return the most recent.
    const pms = await stripe.paymentMethods.list({
      customer: platformCustomerId,
      type: 'card',
      limit: 10,
    })
    if (pms.data.length === 0) return null

    const mostRecent = pms.data.reduce((a, b) => (a.created > b.created ? a : b))

    // Self-heal: set as default + detach stale cards so subsequent renders
    // are cheap and accurate. Fire-and-forget — don't block the render on
    // these writes.
    void (async () => {
      try {
        await stripe.customers.update(platformCustomerId, {
          invoice_settings: { default_payment_method: mostRecent.id },
        })
        for (const pm of pms.data) {
          if (pm.id !== mostRecent.id) {
            try {
              await stripe.paymentMethods.detach(pm.id)
            } catch {
              // best-effort cleanup
            }
          }
        }
      } catch (err) {
        console.warn('[platform-billing] Self-heal failed:', err)
      }
    })()

    return summarize(mostRecent)
  } catch (err) {
    console.warn('[platform-billing] Failed to fetch PM:', err)
    return null
  }
}

/**
 * Sets the given payment method as the customer's default for invoices.
 * Used by the webhook handler after a successful setup Checkout session.
 */
export async function setDefaultPaymentMethod(
  platformCustomerId: string,
  paymentMethodId: string,
): Promise<void> {
  const stripe = getPlatformStripe()
  await stripe.customers.update(platformCustomerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  })
}

/**
 * Detaches a payment method from the customer. Best-effort — failures
 * are swallowed with a warning log since a stale-but-detached PM is not
 * a functional issue.
 */
export async function detachPaymentMethod(paymentMethodId: string): Promise<void> {
  try {
    const stripe = getPlatformStripe()
    await stripe.paymentMethods.detach(paymentMethodId)
  } catch (err) {
    console.warn('[platform-billing] Failed to detach PM', paymentMethodId, err)
  }
}

/**
 * Returns the customer's current default PM ID (without fetching card
 * details). Used by the webhook to know if this is an Add (no previous PM)
 * or Update (previous PM exists, detach it after swapping default).
 */
export async function getCurrentDefaultPaymentMethodId(
  platformCustomerId: string,
  stripe?: Stripe,
): Promise<string | null> {
  const client = stripe ?? getPlatformStripe()
  const customer = await client.customers.retrieve(platformCustomerId)
  if (typeof customer !== 'object' || customer.deleted) return null
  const pm = customer.invoice_settings?.default_payment_method
  if (!pm) return null
  return typeof pm === 'string' ? pm : pm.id
}

// ─── Invoice history (spec 24b) ──────────────────────────────────────────

export interface InvoiceSummary {
  id: string
  number: string | null
  periodLabel: string
  amountDueCents: number
  amountPaidCents: number
  currency: string
  status: string
  createdAt: Date
  hostedInvoiceUrl: string | null
  invoicePdfUrl: string | null
}

/**
 * Derives a human-readable period label for an invoice.
 *
 * Preference order:
 *   1. metadata.period_yyyymm (set by the cron, e.g. "2026-05")
 *   2. month of invoice.created
 */
export function humanPeriodFromInvoice(invoice: Stripe.Invoice): string {
  const metaPeriod = invoice.metadata?.period_yyyymm
  if (metaPeriod && /^\d{4}-\d{2}$/.test(metaPeriod)) {
    return humanPeriod(metaPeriod)
  }
  if (invoice.created) {
    const d = new Date(invoice.created * 1000)
    return humanPeriod(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    )
  }
  return '—'
}

/**
 * Fetches recent invoices for the platform customer, mapped to a
 * summary shape for the Settings UI.
 *
 * Returns [] on missing customer or Stripe API failure (swallowed with
 * a warning log).
 */
export async function fetchPlatformInvoices(
  platformCustomerId: string | null,
  limit = 12,
): Promise<InvoiceSummary[]> {
  if (!platformCustomerId) return []
  try {
    const stripe = getPlatformStripe()
    const list = await stripe.invoices.list({
      customer: platformCustomerId,
      limit,
    })
    return list.data.map(inv => ({
      id: inv.id ?? '',
      number: inv.number ?? null,
      periodLabel: humanPeriodFromInvoice(inv),
      amountDueCents: inv.amount_due,
      amountPaidCents: inv.amount_paid,
      currency: inv.currency,
      status: inv.status ?? 'draft',
      createdAt: new Date(inv.created * 1000),
      hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      invoicePdfUrl: inv.invoice_pdf ?? null,
    }))
  } catch (err) {
    console.warn('[platform-billing] Failed to list invoices:', err)
    return []
  }
}

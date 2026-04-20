import type Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getPlatformStripe } from './platform-stripe'

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

/**
 * Fetches the customer's default payment method summary for display.
 * Returns null if no customer ID, no default PM, or on Stripe API error.
 *
 * Called from the Settings page server component on each render. Worth
 * ~100ms over the wire but always accurate (no cache drift).
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

    const pm = customer.invoice_settings?.default_payment_method
    if (!pm || typeof pm === 'string') return null
    if (!pm.card) return null

    return {
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    }
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

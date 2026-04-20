import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getPlatformStripe } from '@/src/winback/lib/platform-stripe'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 24b — POST /api/billing/portal-session
 *
 * Creates a Stripe Customer Portal session so the customer can manage
 * their billing (view all invoices, download PDFs, update payment
 * method, update billing address).
 *
 * The portal config is set once in the Stripe dashboard
 * (Settings → Billing → Customer Portal). Must be activated before
 * this endpoint works.
 *
 * Returns { url } — client opens in a new tab.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [customer] = await db
    .select({ id: customers.id, stripePlatformCustomerId: customers.stripePlatformCustomerId })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }
  if (!customer.stripePlatformCustomerId) {
    return NextResponse.json({
      error: 'No billing account yet. Add a payment method first.',
    }, { status: 400 })
  }

  try {
    const stripe = getPlatformStripe()
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'

    const portal = await stripe.billingPortal.sessions.create({
      customer: customer.stripePlatformCustomerId,
      return_url: `${baseUrl}/settings`,
    })

    logEvent({
      name: 'billing_portal_opened',
      customerId: customer.id,
    })

    return NextResponse.json({ url: portal.url })
  } catch (err) {
    console.error('[billing/portal-session] Stripe error:', err)
    return NextResponse.json({
      error: 'Failed to open billing portal',
      detail: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }
}

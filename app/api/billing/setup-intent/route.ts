import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getPlatformStripe } from '@/src/winback/lib/platform-stripe'
import { getOrCreatePlatformCustomer } from '@/src/winback/lib/platform-billing'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 23 — POST /api/billing/setup-intent
 *
 * Creates a Stripe Checkout session in `setup` mode so the user can
 * save a card on Winback's platform account. Returns the Checkout URL;
 * the client redirects to it.
 *
 * Same endpoint handles Add (first card) and Update (replace existing) —
 * the webhook handler detaches the previous PM after swapping the
 * default.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  try {
    const platformCustomerId = await getOrCreatePlatformCustomer(customer.id)
    const stripe = getPlatformStripe()
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: platformCustomerId,
      payment_method_types: ['card'],
      success_url: `${baseUrl}/settings?billing=success`,
      cancel_url: `${baseUrl}/settings?billing=cancelled`,
      metadata: {
        winback_customer_id: customer.id,
        flow: 'platform_card_capture',
      },
    })

    logEvent({
      name: 'billing_setup_started',
      customerId: customer.id,
      properties: { stripeSessionId: checkoutSession.id },
    })

    if (!checkoutSession.url) {
      return NextResponse.json({ error: 'No checkout URL returned from Stripe' }, { status: 500 })
    }

    return NextResponse.json({ url: checkoutSession.url })
  } catch (err) {
    console.error('[billing/setup-intent] error:', err)
    return NextResponse.json(
      { error: 'Failed to create checkout session', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}

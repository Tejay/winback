import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { logEvent } from '@/src/winback/lib/events'
import { verifySubscriberToken } from '@/src/winback/lib/unsubscribe-token'

/**
 * Spec 20c — Creates a Stripe Checkout session for the price chosen by the
 * subscriber on the chooser page. Token-protected.
 *
 * The recovery itself is recorded by the existing checkout.session.completed
 * webhook handler (processCheckoutRecovery in app/api/stripe/webhook/route.ts)
 * — it reads the winback_subscriber_id metadata and inserts a STRONG recovery.
 * This route only creates the session.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ subscriberId: string }> }
) {
  const { subscriberId } = await params
  const token = req.nextUrl.searchParams.get('t')
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? 'https://winbackflow.co'

  if (!verifySubscriberToken(subscriberId, 'reactivate', token)) {
    return NextResponse.json({ error: 'Invalid or missing token' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const priceId = typeof body.priceId === 'string' ? body.priceId : null
  if (!priceId) {
    return NextResponse.json({ error: 'priceId is required' }, { status: 400 })
  }

  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!subscriber) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, subscriber.customerId))
    .limit(1)

  if (!customer?.stripeAccessToken) {
    return NextResponse.json({ error: 'Account not connected' }, { status: 400 })
  }

  const stripe = new Stripe(decrypt(customer.stripeAccessToken))

  // Security: verify the priceId actually belongs to the connected account
  // (prevents arbitrary price injection from the client).
  try {
    const price = await stripe.prices.retrieve(priceId)
    if (!price.active || price.type !== 'recurring') {
      return NextResponse.json({ error: 'Selected plan is not available' }, { status: 400 })
    }
  } catch {
    return NextResponse.json({ error: 'Selected plan is not available' }, { status: 400 })
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: subscriber.stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${baseUrl}/welcome-back?recovered=true`,
      cancel_url: `${baseUrl}/welcome-back?recovered=false`,
      metadata: {
        winback_subscriber_id: subscriberId,
        winback_customer_id: customer.id,
      },
    })

    logEvent({
      name: 'reactivate_checkout_started',
      customerId: customer.id,
      properties: { subscriberId, priceId },
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error('Reactivate checkout failed:', err)
    logEvent({
      name: 'reactivate_failed',
      customerId: customer.id,
      properties: {
        subscriberId,
        reason: 'checkout_failed',
        priceId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 })
  }
}

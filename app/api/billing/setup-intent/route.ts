import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getPlatformStripe } from '@/src/winback/lib/platform-stripe'
import { getOrCreatePlatformCustomer } from '@/src/winback/lib/platform-billing'
import { logEvent } from '@/src/winback/lib/events'

const ALLOWED_TIERS = new Set(['starter', 'growth', 'scale', 'custom'])

/**
 * POST /api/billing/setup-intent
 *
 * Creates a Stripe Checkout session in `setup` mode so the user can
 * save a card on Winback's platform account. Returns the Checkout URL;
 * the client redirects to it.
 *
 * Optional `confirmedTier` body field: when present, it's forwarded into
 * the Checkout session metadata so the post-redirect /billing/success
 * page can call commitActivation with the same tier the customer saw on
 * the activation page. When absent (settings page "Update card" flow),
 * the success page falls back to the customer's recommended_tier.
 */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let confirmedTier: string | null = null
  try {
    const body = (await req.json()) as { confirmedTier?: string }
    if (body.confirmedTier && ALLOWED_TIERS.has(body.confirmedTier)) {
      confirmedTier = body.confirmedTier
    }
  } catch {
    // No body / invalid JSON — non-tier flow (settings page card update).
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
      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/billing/activate?cancelled=1`,
      metadata: {
        winback_customer_id: customer.id,
        flow: 'platform_card_capture',
        ...(confirmedTier ? { winback_confirmed_tier: confirmedTier } : {}),
      },
    })

    logEvent({
      name: 'billing_setup_started',
      customerId: customer.id,
      properties: {
        stripeSessionId: checkoutSession.id,
        confirmedTier,
      },
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

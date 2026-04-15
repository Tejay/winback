import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, settlementRequests } from '@/lib/schema'
import { and, eq } from 'drizzle-orm'
import { computeOpenObligations } from '@/src/winback/lib/obligations'

/**
 * Creates a Stripe Checkout Session on the Winback PLATFORM Stripe account
 * (NOT the merchant's connected account) for a one-time payment equal to
 * the merchant's remaining 12-month attribution obligations.
 *
 * On success, Stripe redirects to `/settings/delete?settlement=success&
 * session_id={CHECKOUT_SESSION_ID}`, where the page verifies the payment
 * and marks `customers.settlement_paid_at`. That unlocks Gates 1-3 so the
 * merchant can finish deleting their workspace.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [customer] = await db
    .select({ id: customers.id, productName: customers.productName })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const obligations = await computeOpenObligations(customer.id)
  if (obligations.openObligationCents === 0) {
    return NextResponse.json({ error: 'No open obligations to settle' }, { status: 400 })
  }

  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    return NextResponse.json({ error: 'Stripe not configured' }, { status: 500 })
  }
  const stripe = new Stripe(secretKey)

  // Reuse an existing pending request if one is still valid — avoids stranding
  // multiple Checkout Sessions against the same obligation.
  const [existing] = await db
    .select({ id: settlementRequests.id, stripeSessionId: settlementRequests.stripeSessionId })
    .from(settlementRequests)
    .where(
      and(
        eq(settlementRequests.customerId, customer.id),
        eq(settlementRequests.status, 'pending'),
      ),
    )
    .limit(1)

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
  const successUrl = `${appUrl}/settings/delete?settlement=success&session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl = `${appUrl}/settings/delete`

  // If a previous pending session exists, try to reuse it — but only if
  // Stripe still considers it open (not expired, not already paid on a
  // different obligation amount).
  if (existing?.stripeSessionId) {
    try {
      const existingSession = await stripe.checkout.sessions.retrieve(existing.stripeSessionId)
      if (
        existingSession.status === 'open' &&
        existingSession.amount_total === obligations.openObligationCents
      ) {
        return NextResponse.json({ checkoutUrl: existingSession.url, reused: true })
      }
    } catch {
      // Fall through and create a fresh session.
    }
  }

  const stripeSession = await stripe.checkout.sessions.create({
    mode: 'payment',
    currency: 'gbp',
    customer_email: session.user.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'gbp',
          unit_amount: obligations.openObligationCents,
          product_data: {
            name: 'Winback — final settlement',
            description: `${obligations.liveCount} attributed subscribers × remaining months (15% rate, 12-month cap)`,
          },
        },
      },
    ],
    metadata: {
      type: 'winback_settlement',
      customerId: customer.id,
      liveCount: String(obligations.liveCount),
    },
    payment_intent_data: {
      metadata: {
        type: 'winback_settlement',
        customerId: customer.id,
      },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  })

  // Upsert a pending settlement_requests row for bookkeeping.
  if (existing) {
    await db
      .update(settlementRequests)
      .set({
        obligationCents: obligations.openObligationCents,
        liveCount: obligations.liveCount,
        stripeSessionId: stripeSession.id,
        requestedAt: new Date(),
      })
      .where(eq(settlementRequests.id, existing.id))
  } else {
    await db.insert(settlementRequests).values({
      customerId: customer.id,
      obligationCents: obligations.openObligationCents,
      liveCount: obligations.liveCount,
      stripeSessionId: stripeSession.id,
      status: 'pending',
    })
  }

  return NextResponse.json({ checkoutUrl: stripeSession.url })
}

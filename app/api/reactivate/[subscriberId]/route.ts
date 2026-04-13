import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries, emailsSent } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ subscriberId: string }> }
) {
  const { subscriberId } = await params
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? 'https://winbackflow.co'

  // Look up subscriber
  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!subscriber) {
    return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false`)
  }

  // Already recovered — just redirect
  if (subscriber.status === 'recovered') {
    return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=true`)
  }

  // Look up customer for access token
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, subscriber.customerId))
    .limit(1)

  if (!customer?.stripeAccessToken) {
    return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false`)
  }

  const accessToken = decrypt(customer.stripeAccessToken)
  const stripe = new Stripe(accessToken)

  try {
    // Step 1: Try to resume subscription (not fully expired)
    if (subscriber.stripeSubscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriber.stripeSubscriptionId)
        if (sub.cancel_at_period_end === true) {
          // Resume it
          await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false })

          // Create strong recovery
          const attributionEndsAt = new Date()
          attributionEndsAt.setFullYear(attributionEndsAt.getFullYear() + 1)

          await db.insert(recoveries).values({
            subscriberId,
            customerId: customer.id,
            planMrrCents: subscriber.mrrCents,
            newStripeSubId: sub.id,
            attributionEndsAt,
            attributionType: 'strong',
          })

          await db
            .update(churnedSubscribers)
            .set({ status: 'recovered', updatedAt: new Date() })
            .where(eq(churnedSubscribers.id, subscriberId))

          console.log('STRONG RECOVERY (resume):', subscriber.email)
          return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=true`)
        }
      } catch {
        // Subscription doesn't exist or can't be resumed — fall through to checkout
      }
    }

    // Step 2: Create fresh Checkout session
    let priceId = subscriber.stripePriceId

    // Fallback: look up prices on connected account
    if (!priceId) {
      const prices = await stripe.prices.list({ active: true, type: 'recurring', limit: 1 })
      priceId = prices.data[0]?.id ?? null
    }

    if (!priceId) {
      console.error('No price found for reactivation:', subscriberId)
      return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false`)
    }

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

    return NextResponse.redirect(session.url!)
  } catch (err) {
    console.error('Reactivation failed:', err)
    return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false`)
  }
}

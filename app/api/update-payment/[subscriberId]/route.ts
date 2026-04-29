import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { logEvent } from '@/src/winback/lib/events'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ subscriberId: string }> }
) {
  const { subscriberId } = await params
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.NEXTAUTH_URL ?? 'https://winbackflow.co'

  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!subscriber) {
    return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false`)
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, subscriber.customerId))
    .limit(1)

  if (!customer?.stripeAccessToken) {
    return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false`)
  }

  // Record click for attribution + engagement (spec 21a). Column name kept
  // as billingPortalClickedAt — semantically it's "customer clicked the
  // update-payment link," regardless of which Stripe product is on the
  // other side. Renaming would be churn for no real benefit.
  await db
    .update(churnedSubscribers)
    .set({
      billingPortalClickedAt: new Date(),
      lastEngagementAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'link_clicked',
    properties: { subscriberId, linkType: 'checkout_setup' },
  })

  console.log('Update-payment click recorded:', subscriberId)

  // Spec 35 — Stripe Checkout Session in setup mode (replaces Billing
  // Portal redirect). Setup mode collects a payment method without
  // charging anything; the merchant's default Payment Method
  // Configuration drives which methods are surfaced (Apple Pay, Google
  // Pay, Link, card). The webhook for checkout.session.completed
  // attaches the new PM as default and retries any open failed invoice
  // server-side.
  try {
    const accessToken = decrypt(customer.stripeAccessToken)
    const stripe = new Stripe(accessToken)

    // Stripe Checkout in setup mode requires `currency` (drives method
    // filtering — e.g. SEPA for EUR, BACS for GBP). Pull the subscription
    // we're trying to recover so the picker matches what'll actually be
    // charged. Fall back to USD if the subscription isn't fetchable
    // (deleted upstream, transient API blip, etc.) — better to surface a
    // working Checkout in the merchant's default currency than fail.
    let currency = 'usd'
    if (subscriber.stripeSubscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriber.stripeSubscriptionId)
        if (sub.currency) currency = sub.currency
      } catch (err) {
        console.warn('[update-payment] subscription retrieve failed, defaulting to usd:', err)
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode:        'setup',
      currency,
      customer:    subscriber.stripeCustomerId,
      success_url: `${baseUrl}/welcome-back?recovered=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/welcome-back?recovered=false`,
      metadata: {
        winback_subscriber_id: subscriberId,
        winback_customer_id:   subscriber.customerId,
        winback_flow:          'dunning_update_payment',
      },
    })

    if (!session.url) {
      console.error('Checkout session created without url:', session.id)
      return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false`)
    }

    return NextResponse.redirect(session.url)
  } catch (err) {
    console.error('Checkout setup session failed:', err)
    return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false`)
  }
}

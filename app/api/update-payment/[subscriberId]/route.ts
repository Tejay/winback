import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'

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

  // Record click for attribution
  await db
    .update(churnedSubscribers)
    .set({ billingPortalClickedAt: new Date(), updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  console.log('Billing portal click recorded:', subscriberId)

  try {
    const accessToken = decrypt(customer.stripeAccessToken)
    const stripe = new Stripe(accessToken)

    const session = await stripe.billingPortal.sessions.create({
      customer: subscriber.stripeCustomerId,
      return_url: `${baseUrl}/welcome-back?recovered=true`,
    })

    return NextResponse.redirect(session.url)
  } catch (err) {
    console.error('Billing portal session failed:', err)
    return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false`)
  }
}

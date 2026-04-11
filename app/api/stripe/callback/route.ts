import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { encrypt } from '@/src/winback/lib/encryption'
import { extractSignals } from '@/src/winback/lib/stripe'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import Stripe from 'stripe'

const baseUrl = () => process.env.NEXTAUTH_URL!

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl

  if (searchParams.get('error')) {
    return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=denied`)
  }

  const code = searchParams.get('code')
  const state = searchParams.get('state')

  if (!code || !state) {
    return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=missing_params`)
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, state))
    .limit(1)

  if (!customer) {
    return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=invalid_state`)
  }

  const tokenRes = await fetch('https://connect.stripe.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_secret: process.env.STRIPE_SECRET_KEY!,
    }),
  })

  if (!tokenRes.ok) {
    return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=token_exchange_failed`)
  }

  const tokenData = await tokenRes.json()
  const accessToken = tokenData.access_token
  const newAccountId = tokenData.stripe_user_id

  // Handle reconnect: keep original account ID if one exists
  const accountIdToSave = customer.stripeAccountId ?? newAccountId
  if (customer.stripeAccountId && customer.stripeAccountId !== newAccountId) {
    console.warn(
      `Stripe reconnect: user ${customer.id} had account ${customer.stripeAccountId}, ` +
      `OAuth returned ${newAccountId}. Keeping original account ID.`
    )
  }

  await db
    .update(customers)
    .set({
      stripeAccountId: accountIdToSave,
      stripeAccessToken: encrypt(accessToken),
      updatedAt: new Date(),
    })
    .where(eq(customers.id, state))

  // Historical seeding — only on first connect (no existing account ID)
  if (!customer.stripeAccountId) {
    // Seeding runs in the background via a separate API call from the client
    // to avoid fire-and-forget issues on serverless
    console.log('First Stripe connect — historical seeding will run on dashboard load')
  }

  return NextResponse.redirect(`${baseUrl()}/onboarding/gmail`)
}

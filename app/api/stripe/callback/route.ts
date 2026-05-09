import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { encrypt } from '@/src/winback/lib/encryption'
import { extractSignals } from '@/src/winback/lib/stripe'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { logEvent } from '@/src/winback/lib/events'
import Stripe from 'stripe'

const baseUrl = () => process.env.NEXTAUTH_URL!

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl

  if (searchParams.get('error')) {
    // User hit cancel / decline on Stripe's consent screen.
    await logEvent({ name: 'oauth_denied', properties: { errorType: 'denied' } })
    return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=denied`)
  }

  const code = searchParams.get('code')
  const state = searchParams.get('state')

  if (!code || !state) {
    await logEvent({ name: 'oauth_error', properties: { errorType: 'missing_params' } })
    return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=missing_params`)
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, state))
    .limit(1)

  if (!customer) {
    await logEvent({
      name: 'oauth_error',
      properties: { errorType: 'invalid_state', state },
    })
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
    // Spec 48 — capture Stripe's response detail so /admin/events shows
    // the real cause (invalid_grant, related-account block, expired
    // code, etc.) instead of just "token_exchange_failed".
    const httpStatus = tokenRes.status
    const rawText = await tokenRes.text().catch(() => '')
    let stripeError: string | null = null
    let stripeErrorDescription: string | null = null
    let stripeMessage: string | null = null
    let parsedJson: unknown = null
    try {
      parsedJson = JSON.parse(rawText)
    } catch {
      // Non-JSON response (HTML error page, empty, etc.) — responseSnippet
      // below carries the raw text instead.
    }
    if (parsedJson && typeof parsedJson === 'object') {
      const j = parsedJson as Record<string, unknown>
      stripeError = typeof j.error === 'string' ? j.error : null
      stripeErrorDescription = typeof j.error_description === 'string' ? j.error_description : null
      if (!stripeError && j.error && typeof j.error === 'object') {
        const nested = j.error as Record<string, unknown>
        stripeMessage = typeof nested.message === 'string' ? nested.message : null
        stripeError = typeof nested.type === 'string' ? nested.type : null
      }
    }

    await logEvent({
      name: 'oauth_error',
      customerId: customer.id,
      userId: customer.userId,
      properties: {
        errorType: 'token_exchange_failed',
        httpStatus,
        stripeError,
        stripeErrorDescription,
        stripeMessage,
        responseSnippet: rawText.slice(0, 500),
      },
    })
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
      onboardingComplete: true,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, state))

  const firstConnect = !customer.stripeAccountId

  // Trigger historical backfill on first connect (fire-and-forget via internal API)
  if (firstConnect) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? baseUrl()
    fetch(`${appUrl}/api/backfill/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ customerId: state }),
    }).catch((err) => {
      console.error('Failed to trigger backfill:', err)
    })
  }

  // Successful connection — the positive leg of the conversion funnel.
  await logEvent({
    name: 'oauth_completed',
    customerId: customer.id,
    userId: customer.userId,
    properties: { stripeAccountId: accountIdToSave, firstConnect },
  })

  return NextResponse.redirect(`${baseUrl()}/dashboard`)
}

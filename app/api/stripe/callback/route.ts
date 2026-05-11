import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and, ne } from 'drizzle-orm'
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

  // Spec 56 — reject re-linking a Stripe account that another Winback
  // customer already owns. Without this, two wb_customers rows would
  // both claim the same stripe_account_id and webhook handlers' .limit(1)
  // would silently pick one (multi-tenant data leak). The DB also has
  // a partial UNIQUE index (migration 036) as the integrity guarantee;
  // this pre-check exists so the user sees a friendly error instead of
  // a 500.
  const [conflict] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(and(
      eq(customers.stripeAccountId, newAccountId),
      ne(customers.id, state),
    ))
    .limit(1)

  if (conflict) {
    await logEvent({
      name: 'oauth_error',
      customerId: customer.id,
      userId: customer.userId,
      properties: {
        errorType: 'account_already_linked',
        newAccountId,
        conflictingCustomerId: conflict.id,
      },
    })
    return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=account_already_linked`)
  }

  // Spec 49 — always trust OAuth's response. The previous "keep original
  // ID" path silently dropped webhooks when a merchant reconnected to a
  // different Stripe account.
  const previousAccountId = customer.stripeAccountId
  const accountChanged = previousAccountId !== null && previousAccountId !== newAccountId
  const firstConnect = !previousAccountId
  const needsBackfill = firstConnect || accountChanged

  if (accountChanged) {
    console.warn(
      `Stripe reconnect: user ${customer.id} switched from account ${previousAccountId} ` +
      `to ${newAccountId}. Backfilling against the new account; old churned_subscribers rows ` +
      `(tied to ${previousAccountId}) remain in DB.`
    )
    await logEvent({
      name: 'oauth_account_changed',
      customerId: customer.id,
      userId: customer.userId,
      properties: { previousAccountId, newAccountId },
    })
  }

  await db
    .update(customers)
    .set({
      stripeAccountId: newAccountId,
      stripeAccessToken: encrypt(accessToken),
      onboardingComplete: true,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, state))

  // Trigger historical backfill on first connect or when the account changed
  // (fire-and-forget via internal API).
  if (needsBackfill) {
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
    properties: { stripeAccountId: newAccountId, firstConnect },
  })

  return NextResponse.redirect(`${baseUrl()}/dashboard`)
}

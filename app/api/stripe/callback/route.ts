import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { encrypt } from '@/src/winback/lib/encryption'
import { extractSignals } from '@/src/winback/lib/stripe'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import Stripe from 'stripe'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl

  if (searchParams.get('error')) {
    return NextResponse.redirect(
      new URL('/onboarding/stripe?error=denied', req.url)
    )
  }

  const code = searchParams.get('code')
  const state = searchParams.get('state')

  if (!code || !state) {
    return NextResponse.redirect(
      new URL('/onboarding/stripe?error=missing_params', req.url)
    )
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, state))
    .limit(1)

  if (!customer) {
    return NextResponse.redirect(
      new URL('/onboarding/stripe?error=invalid_state', req.url)
    )
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
    return NextResponse.redirect(
      new URL('/onboarding/stripe?error=token_exchange_failed', req.url)
    )
  }

  const tokenData = await tokenRes.json()
  const accessToken = tokenData.access_token

  await db
    .update(customers)
    .set({
      stripeAccountId: tokenData.stripe_user_id,
      stripeAccessToken: encrypt(accessToken),
      updatedAt: new Date(),
    })
    .where(eq(customers.id, state))

  // Historical seeding — fetch last 90 days of churned subscribers (async, don't block redirect)
  seedHistoricalChurn(state, accessToken, customer).catch((err) =>
    console.error('Historical seeding failed:', err)
  )

  return NextResponse.redirect(new URL('/onboarding/gmail', req.url))
}

async function seedHistoricalChurn(
  customerId: string,
  accessToken: string,
  customer: { founderName: string | null; productName: string | null; changelogText: string | null }
) {
  const stripe = new Stripe(accessToken)

  const ninetyDaysAgo = Math.floor((Date.now() - 90 * 86400000) / 1000)

  // Fetch cancelled subscriptions from last 90 days
  const subscriptions: Stripe.Subscription[] = []
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore && subscriptions.length < 500) {
    const params: Stripe.SubscriptionListParams = {
      status: 'canceled',
      limit: 100,
      created: { gte: ninetyDaysAgo },
    }
    if (startingAfter) params.starting_after = startingAfter

    const batch = await stripe.subscriptions.list(params)
    subscriptions.push(...batch.data)
    hasMore = batch.has_more
    if (batch.data.length > 0) {
      startingAfter = batch.data[batch.data.length - 1].id
    }
  }

  console.log(`Historical seeding: found ${subscriptions.length} cancelled subscriptions`)

  for (const sub of subscriptions) {
    const stripeCustomerId = typeof sub.customer === 'string'
      ? sub.customer
      : sub.customer.id

    // Idempotency check
    const [existing] = await db
      .select({ id: churnedSubscribers.id })
      .from(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.customerId, customerId),
          eq(churnedSubscribers.stripeCustomerId, stripeCustomerId)
        )
      )
      .limit(1)

    if (existing) continue

    try {
      const signals = await extractSignals(sub, accessToken)
      const classification = await classifySubscriber(signals, {
        founderName: customer.founderName ?? undefined,
        productName: customer.productName ?? undefined,
        changelog: customer.changelogText ?? undefined,
      })

      await db.insert(churnedSubscribers).values({
        customerId,
        stripeCustomerId: signals.stripeCustomerId,
        email: signals.email,
        name: signals.name,
        planName: signals.planName,
        mrrCents: signals.mrrCents,
        tenureDays: signals.tenureDays,
        everUpgraded: signals.everUpgraded,
        nearRenewal: signals.nearRenewal,
        paymentFailures: signals.paymentFailures,
        previousSubs: signals.previousSubs,
        stripeEnum: signals.stripeEnum,
        stripeComment: signals.stripeComment,
        cancellationReason: classification.cancellationReason,
        cancellationCategory: classification.cancellationCategory,
        tier: classification.tier,
        confidence: String(classification.confidence),
        triggerKeyword: classification.triggerKeyword,
        winBackSubject: classification.winBackSubject,
        winBackBody: classification.winBackBody,
        status: classification.suppress ? 'lost' : 'pending',
        cancelledAt: signals.cancelledAt,
      })
    } catch (err) {
      console.error(`Failed to seed subscriber ${stripeCustomerId}:`, err)
    }
  }

  console.log(`Historical seeding complete for customer ${customerId}`)
}

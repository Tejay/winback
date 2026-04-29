import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { logEvent } from '@/src/winback/lib/events'
import { signSubscriberToken } from '@/src/winback/lib/unsubscribe-token'

/**
 * Reactivation entry point clicked from email links.
 *
 * Routing (in priority order):
 *  1. Subscriber not found / customer disconnected → fail with explicit reason
 *  2. Already recovered → redirect to welcome-back?recovered=true
 *  3. Subscription resumable (cancel_at_period_end=true) → resume + strong recovery
 *  4. Subscription already active (status=active|trialing) → mark recovered (no
 *     new recovery row), redirect to welcome-back?recovered=true (spec 20a)
 *  5. Multiple active prices on connected account, OR saved price unavailable →
 *     redirect to chooser page (spec 20c)
 *  6. Single active price → direct Checkout
 *  7. No active prices / Checkout failed → fail with explicit reason (spec 20b)
 */

type FailureReason =
  | 'subscriber_not_found'
  | 'account_disconnected'
  | 'price_unavailable'
  | 'checkout_failed'

function failureRedirect(
  baseUrl: string,
  reason: FailureReason,
  customerId?: string,
): NextResponse {
  // Spec 36 — pass winback customer id when we know it so /welcome-back
  // renders the merchant's brand (not Winback's). When the lookup that
  // failed prevented us from knowing it (e.g. subscriber_not_found),
  // fall through without — the page renders neutrally rather than
  // exposing Winback.
  const customerParam = customerId ? `&customer=${customerId}` : ''
  return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=false&reason=${reason}${customerParam}`)
}

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
    logEvent({
      name: 'reactivate_failed',
      properties: { subscriberId, reason: 'subscriber_not_found' },
    })
    return failureRedirect(baseUrl, 'subscriber_not_found')
  }

  // Already recovered — just redirect (no changes, no event)
  if (subscriber.status === 'recovered') {
    return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=true&customer=${subscriber.customerId}`)
  }

  // Look up customer for access token
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, subscriber.customerId))
    .limit(1)

  if (!customer?.stripeAccessToken) {
    logEvent({
      name: 'reactivate_failed',
      customerId: subscriber.customerId,
      properties: { subscriberId, reason: 'account_disconnected' },
    })
    return failureRedirect(baseUrl, 'account_disconnected', subscriber.customerId)
  }

  logEvent({
    name: 'link_clicked',
    customerId: customer.id,
    properties: { subscriberId, linkType: 'reactivate' },
  })

  // Spec 21a — record engagement signal (link click)
  await db
    .update(churnedSubscribers)
    .set({ lastEngagementAt: new Date(), updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  const accessToken = decrypt(customer.stripeAccessToken)
  const stripe = new Stripe(accessToken)

  try {
    // ─── Stage 1: Try to resume existing subscription ───────────────────
    if (subscriber.stripeSubscriptionId) {
      try {
        const sub = await stripe.subscriptions.retrieve(subscriber.stripeSubscriptionId)

        if (sub.cancel_at_period_end === true) {
          // Resume: flip the cancel flag → strong recovery
          await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false })

          await db.insert(recoveries).values({
            subscriberId,
            customerId: customer.id,
            planMrrCents: subscriber.mrrCents,
            newStripeSubId: sub.id,
            attributionType: 'strong',
          })

          await db
            .update(churnedSubscribers)
            .set({
              status: 'recovered',
              founderHandoffResolvedAt: subscriber.founderHandoffAt && !subscriber.founderHandoffResolvedAt
                ? new Date()
                : subscriber.founderHandoffResolvedAt,
              updatedAt: new Date(),
            })
            .where(eq(churnedSubscribers.id, subscriberId))

          logEvent({
            name: 'subscriber_recovered',
            customerId: customer.id,
            properties: {
              subscriberId,
              attributionType: 'strong',
              planMrrCents: subscriber.mrrCents,
              recoveryMethod: 'reactivate_resume',
            },
          })

          console.log('STRONG RECOVERY (resume):', subscriber.email)
          return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=true&customer=${customer.id}`)
        }

        // Spec 20a — Subscription is already active (data drift). Don't create
        // a duplicate. Just correct our records and acknowledge the click.
        if (sub.status === 'active' || sub.status === 'trialing') {
          await db
            .update(churnedSubscribers)
            .set({
              status: 'recovered',
              founderHandoffResolvedAt: subscriber.founderHandoffAt && !subscriber.founderHandoffResolvedAt
                ? new Date()
                : subscriber.founderHandoffResolvedAt,
              updatedAt: new Date(),
            })
            .where(eq(churnedSubscribers.id, subscriberId))

          logEvent({
            name: 'reactivate_already_active',
            customerId: customer.id,
            properties: {
              subscriberId,
              stripeSubscriptionId: sub.id,
              stripeStatus: sub.status,
            },
          })

          console.log('REACTIVATE: already active, no-op:', subscriber.email)
          return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=true&customer=${customer.id}`)
        }
        // else: status is canceled / incomplete / past_due / unpaid → fall
        // through to checkout (Stage 2)
      } catch {
        // Subscription doesn't exist or can't be retrieved — fall through
      }
    }

    // ─── Stage 2: Look up active prices on the connected account ────────
    const activePricesList = await stripe.prices.list({
      active: true,
      type: 'recurring',
      limit: 10,
    })
    const activePrices = activePricesList.data

    if (activePrices.length === 0) {
      logEvent({
        name: 'reactivate_failed',
        customerId: customer.id,
        properties: { subscriberId, reason: 'price_unavailable' },
      })
      return failureRedirect(baseUrl, 'price_unavailable', customer.id)
    }

    // ─── Spec 20c routing ───────────────────────────────────────────────
    // Fast path: only one active price AND it matches the subscriber's saved
    // price → skip the chooser, go straight to Checkout (no extra friction).
    const savedPriceStillActive = !!subscriber.stripePriceId
      && activePrices.some(p => p.id === subscriber.stripePriceId)

    const shouldUseChooser =
      activePrices.length > 1 || (subscriber.stripePriceId && !savedPriceStillActive)

    if (shouldUseChooser) {
      const token = signSubscriberToken(subscriberId, 'reactivate')
      return NextResponse.redirect(`${baseUrl}/reactivate/${subscriberId}?t=${token}`)
    }

    // ─── Stage 3: Single-price direct Checkout ──────────────────────────
    // Reach here when: 1 active price AND (matches saved OR subscriber has no saved price)
    const priceId = subscriber.stripePriceId ?? activePrices[0].id

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: subscriber.stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // Spec 36 — pass winback customer id so /welcome-back can render
      // the merchant's brand (not Winback's).
      success_url: `${baseUrl}/welcome-back?recovered=true&customer=${customer.id}`,
      cancel_url: `${baseUrl}/welcome-back?recovered=false&customer=${customer.id}`,
      metadata: {
        winback_subscriber_id: subscriberId,
        winback_customer_id: customer.id,
      },
    })

    return NextResponse.redirect(session.url!)
  } catch (err) {
    console.error('Reactivation failed:', err)
    logEvent({
      name: 'reactivate_failed',
      customerId: customer.id,
      properties: {
        subscriberId,
        reason: 'checkout_failed',
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return failureRedirect(baseUrl, 'checkout_failed', customer.id)
  }
}

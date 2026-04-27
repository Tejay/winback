import Stripe from 'stripe'
import { db } from '@/lib/db'
import { users, customers, churnedSubscribers, recoveries, emailsSent } from '@/lib/schema'
import { eq, and, ne, inArray, desc, gt, isNull } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { extractSignals } from '@/src/winback/lib/stripe'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { scheduleExitEmail, sendDunningEmail } from '@/src/winback/lib/email'
import { logEvent } from '@/src/winback/lib/events'
import {
  getCurrentDefaultPaymentMethodId,
  setDefaultPaymentMethod,
  detachPaymentMethod,
} from '@/src/winback/lib/platform-billing'
import { ensureActivation } from '@/src/winback/lib/activation'
import { refundPerformanceFee, PERF_FEE_REFUND_WINDOW_DAYS } from '@/src/winback/lib/performance-fee'
import { sendPlatformPaymentFailedEmail } from '@/src/winback/lib/billing-notifications'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!)
}

/**
 * Phase B — runs ensureActivation in a try/catch so a Stripe API blip never
 * blocks the recovery webhook from acknowledging. Activation is idempotent;
 * a retry (Stripe redelivers, or a follow-up webhook) will reach the same
 * end state.
 */
async function triggerActivation(wbCustomerId: string, ctx: string): Promise<void> {
  try {
    const result = await ensureActivation(wbCustomerId)
    console.log(`[activation:${ctx}] state=${result.state}`, wbCustomerId)
  } catch (err) {
    console.error(`[activation:${ctx}] failed for`, wbCustomerId, err)
    logEvent({
      name: 'activation_failed',
      customerId: wbCustomerId,
      properties: {
        context: ctx,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    })
  }
}

/**
 * Phase B — when a previously-recovered subscriber re-cancels, refund any
 * win-back perf fee charged within the last 14 days. Idempotent and safe
 * to call on every cancellation event.
 */
async function maybeRefundRecentWinBack(subscriberId: string): Promise<void> {
  const cutoff = new Date(Date.now() - PERF_FEE_REFUND_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const refundable = await db
    .select({ id: recoveries.id })
    .from(recoveries)
    .where(
      and(
        eq(recoveries.subscriberId, subscriberId),
        eq(recoveries.recoveryType, 'win_back'),
        gt(recoveries.perfFeeChargedAt, cutoff),
        isNull(recoveries.perfFeeRefundedAt),
      ),
    )
    .orderBy(desc(recoveries.perfFeeChargedAt))
    .limit(1)

  if (!refundable.length) return

  try {
    const result = await refundPerformanceFee(refundable[0].id)
    console.log(`[refund] win-back ${refundable[0].id} method=${result.method}`)
    logEvent({
      name: 'win_back_refunded',
      properties: { recoveryId: refundable[0].id, method: result.method },
    })
  } catch (err) {
    console.error('[refund] failed for recovery', refundable[0].id, err)
  }
}

export async function POST(req: Request) {
  const rawBody = Buffer.from(await req.arrayBuffer())
  const sig = req.headers.get('stripe-signature') ?? ''

  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err) {
    console.error('Webhook signature failed:', err)
    // Spec 26 — observability: emit so the overview's Errors counter
    // catches webhook-secret rotations and impersonation attempts. Source
    // IP helps distinguish "we rotated the secret" from real bad-actor.
    await logEvent({
      name: 'webhook_signature_invalid',
      properties: {
        sourceIp: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? null,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    })
    return new Response('Invalid signature', { status: 400 })
  }

  console.log('Webhook received:', event.type, 'account:', event.account ?? 'none')

  try {
    if (event.type === 'customer.subscription.deleted') {
      if (event.account) {
        await processChurn(event)
      } else {
        // Phase B — platform-side subscription canceled (our $99/mo).
        await processPlatformSubscriptionDeleted(event)
      }
    }
    if (event.type === 'customer.subscription.created') {
      await processRecovery(event)
    }
    if (event.type === 'checkout.session.completed') {
      // Spec 23 — route by metadata: platform card capture vs reactivation checkout.
      const session = event.data.object as Stripe.Checkout.Session
      if (session.metadata?.flow === 'platform_card_capture') {
        await processPlatformCardCapture(event)
      } else if (session.metadata?.winback_subscriber_id) {
        await processCheckoutRecovery(event)
      }
    }
    if (event.type === 'invoice.payment_failed') {
      // Connect account → dunning/attribution logic (existing)
      // Platform account → our own billing (spec 24a)
      if (event.account) {
        await processPaymentFailed(event)
      } else {
        await processPlatformInvoiceEvent(event)
      }
    }
    if (event.type === 'invoice.payment_succeeded') {
      if (event.account) {
        await processPaymentSucceeded(event)
      } else {
        await processPlatformInvoiceEvent(event)
      }
    }
    // Spec 24a — also listen for `invoice.paid` on platform (fires alongside
    // payment_succeeded in most cases, but covers manual pays from the
    // customer portal too). Only process on platform account.
    if (event.type === 'invoice.paid' && !event.account) {
      await processPlatformInvoiceEvent(event)
    }
  } catch (err) {
    console.error('Webhook processing error:', err)
    return new Response('Processing error', { status: 500 })
  }

  return new Response('ok', { status: 200 })
}

async function processChurn(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription
  const accountId = event.account

  if (!accountId) {
    console.log('No account ID on event, skipping')
    return
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.stripeAccountId, accountId))
    .limit(1)

  if (!customer) {
    console.log('Unknown Stripe account:', accountId)
    return
  }

  const stripeCustomerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id

  // Idempotency check
  const [existing] = await db
    .select({ id: churnedSubscribers.id })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.stripeCustomerId, stripeCustomerId)
      )
    )
    .limit(1)

  if (existing) {
    // Duplicate connected-account event — but if this is a re-cancel within
    // the win-back refund window, refund the previous performance fee
    // (Phase B). Idempotent and safe.
    await maybeRefundRecentWinBack(existing.id)
    return
  }

  const decryptedToken = decrypt(customer.stripeAccessToken!)
  const signals = await extractSignals(subscription, decryptedToken)

  // Initial churn — nothing sent yet, so the classifier sees emails_sent=0.
  const signalsForClassifier = { ...signals, emailsSent: 0 }

  const classification = await classifySubscriber(signalsForClassifier, {
    founderName: customer.founderName ?? undefined,
    productName: customer.productName ?? undefined,
    changelog: customer.changelogText ?? undefined,
  })

  const [newSub] = await db
    .insert(churnedSubscribers)
    .values({
      customerId: customer.id,
      stripeCustomerId: signals.stripeCustomerId,
      stripeSubscriptionId: signals.stripeSubscriptionId,
      stripePriceId: signals.stripePriceId,
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
      triggerNeed: classification.triggerNeed,
      winBackSubject: classification.winBackSubject,
      winBackBody: classification.winBackBody,
      handoffReasoning:   classification.handoffReasoning,
      recoveryLikelihood: classification.recoveryLikelihood,
      status: classification.suppress ? 'lost' : 'pending',
      fallbackDays: 90,
      cancelledAt: signals.cancelledAt,
    })
    .returning({ id: churnedSubscribers.id })

  console.log('Churned subscriber saved:', newSub.id, signals.email)

  if (!classification.suppress && signals.email) {
    // Get founder's name from users table if not set on customer
    let founderName = customer.founderName
    if (!founderName) {
      const [user] = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, customer.userId))
        .limit(1)
      founderName = user?.name ?? user?.email?.split('@')[0] ?? 'The team'
    }
    await scheduleExitEmail({
      subscriberId: newSub.id,
      email: signals.email,
      classification,
      fromName: founderName,
    })
  }
}

async function processRecovery(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription
  const accountId = event.account

  if (!accountId) return

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.stripeAccountId, accountId))
    .limit(1)

  if (!customer) return

  const stripeCustomerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id

  const [churned] = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.stripeCustomerId, stripeCustomerId),
        ne(churnedSubscribers.status, 'recovered')
      )
    )
    .limit(1)

  if (!churned) return

  // Only count as recovery if we actually emailed them
  const [recentEmail] = await db
    .select({ id: emailsSent.id, sentAt: emailsSent.sentAt, repliedAt: emailsSent.repliedAt })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, churned.id))
    .orderBy(desc(emailsSent.sentAt))
    .limit(1)

  if (!recentEmail) {
    console.log('Resubscription but no emails sent — not counting as recovery:', churned.email)
    return
  }

  // Spec 21b/22a — handoff & pause attribution window. If Winback handed off
  // to the founder OR the founder proactively paused within the last 30 days,
  // any recovery in that window is strong (the founder acted on our surfacing).
  const HANDOFF_ATTRIBUTION_DAYS = 30
  let attributionType: string | null = null

  if (churned.founderHandoffAt) {
    const daysSinceHandoff = Math.floor(
      (Date.now() - churned.founderHandoffAt.getTime()) / (1000 * 60 * 60 * 24)
    )
    if (daysSinceHandoff <= HANDOFF_ATTRIBUTION_DAYS) {
      attributionType = 'strong'
    }
  }

  // Spec 22a — proactive pause also earns the strong window
  if (!attributionType && churned.aiPausedAt) {
    const daysSincePause = Math.floor(
      (Date.now() - churned.aiPausedAt.getTime()) / (1000 * 60 * 60 * 24)
    )
    if (daysSincePause <= HANDOFF_ATTRIBUTION_DAYS) {
      attributionType = 'strong'
    }
  }

  // Fall back to evidence-based attribution (spec 18)
  if (!attributionType) {
    if (churned.billingPortalClickedAt) {
      attributionType = 'strong'
    } else if (recentEmail.repliedAt) {
      attributionType = 'strong'
    } else if (recentEmail.sentAt) {
      const daysSinceEmail = Math.floor(
        (Date.now() - recentEmail.sentAt.getTime()) / (1000 * 60 * 60 * 24)
      )
      if (daysSinceEmail <= 14) {
        attributionType = 'weak'
      } else {
        attributionType = 'organic'
      }
    } else {
      attributionType = 'organic'
    }
  }

  const planItem = subscription.items?.data[0]
  const mrrCents = planItem?.price?.unit_amount ?? 0

  await db.insert(recoveries).values({
    subscriberId: churned.id,
    customerId: customer.id,
    planMrrCents: mrrCents,
    newStripeSubId: subscription.id,
    attributionType,
    recoveryType: 'win_back',
  })

  // Spec 21b — also resolve any pending handoff
  await db
    .update(churnedSubscribers)
    .set({
      status: 'recovered',
      founderHandoffResolvedAt: churned.founderHandoffAt && !churned.founderHandoffResolvedAt
        ? new Date()
        : churned.founderHandoffResolvedAt,
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, churned.id))

  // Log recovery event
  logEvent({
    name: 'subscriber_recovered',
    customerId: customer.id,
    properties: {
      subscriberId: churned.id,
      attributionType,
      planMrrCents: mrrCents,
      recoveryMethod: 'subscription_created',
    },
  })

  console.log(`${attributionType.toUpperCase()} RECOVERY:`, churned.email, 'at', mrrCents, 'cents/mo')

  // Phase B — converge on activation. ensureActivation is idempotent and
  // only charges the perf fee when the recovery is strong-attribution AND
  // a subscription is live (i.e. card on file). Otherwise it queues the
  // recovery and waits for the card-capture webhook to call back.
  if (attributionType === 'strong') {
    await triggerActivation(customer.id, 'subscription_created')
  }
}

async function processCheckoutRecovery(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session
  const subscriberId = session.metadata?.winback_subscriber_id
  const customerId = session.metadata?.winback_customer_id

  if (!subscriberId || !customerId) return // Not a Winback checkout

  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)

  if (!subscriber) return
  if (subscriber.status === 'recovered') return // Already recovered — idempotent

  const mrrCents = subscriber.mrrCents

  await db.insert(recoveries).values({
    subscriberId,
    customerId,
    planMrrCents: mrrCents,
    newStripeSubId: session.subscription as string ?? null,
    attributionType: 'strong',
    recoveryType: 'win_back',
  })

  // Spec 21b — also resolve any pending handoff
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

  // Log recovery event
  logEvent({
    name: 'subscriber_recovered',
    customerId,
    properties: {
      subscriberId,
      attributionType: 'strong',
      planMrrCents: mrrCents,
      recoveryMethod: 'checkout',
    },
  })

  console.log('STRONG RECOVERY:', subscriber.email, 'at', mrrCents, 'cents/mo')

  // Phase B — converge on activation (always strong here, so always trigger).
  await triggerActivation(customerId, 'checkout_recovery')
}

async function processPaymentFailed(event: Stripe.Event) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoice = event.data.object as any
  const accountId = event.account

  if (!accountId) return
  if (!invoice.subscription) return // One-time payment, not our scope

  // Only email on first attempt
  if (invoice.attempt_count && invoice.attempt_count > 1) {
    console.log('Payment retry failure (attempt', invoice.attempt_count, ') — skipping email')
    return
  }

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.stripeAccountId, accountId))
    .limit(1)

  if (!customer) return

  const stripeCustomerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : (invoice.customer as Stripe.Customer)?.id ?? ''

  // Idempotency: check if we already sent a dunning email for this subscriber
  const [existingSub] = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.stripeCustomerId, stripeCustomerId),
        eq(churnedSubscribers.cancellationReason, 'Payment failed')
      )
    )
    .limit(1)

  if (existingSub) {
    const [existingEmail] = await db
      .select({ id: emailsSent.id })
      .from(emailsSent)
      .where(
        and(
          eq(emailsSent.subscriberId, existingSub.id),
          eq(emailsSent.type, 'dunning')
        )
      )
      .limit(1)

    if (existingEmail) {
      console.log('Dunning email already sent for', stripeCustomerId)
      return
    }
  }

  // Get customer details from Stripe
  const accessToken = decrypt(customer.stripeAccessToken!)
  const stripe = new Stripe(accessToken)
  const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer

  if (!stripeCustomer.email) {
    console.log('Payment failed but no email on customer:', stripeCustomerId)
    return
  }

  // Get current payment method for attribution tracking later
  const currentPM = stripeCustomer.invoice_settings?.default_payment_method
  const paymentMethodId = typeof currentPM === 'string' ? currentPM : currentPM?.id ?? null

  // Create or find subscriber record
  let subscriberId: string
  if (existingSub) {
    subscriberId = existingSub.id
  } else {
    const subscriptionId = typeof invoice.subscription === 'string'
      ? invoice.subscription
      : (invoice.subscription as Stripe.Subscription)?.id ?? ''

    const [newSub] = await db
      .insert(churnedSubscribers)
      .values({
        customerId: customer.id,
        stripeCustomerId,
        stripeSubscriptionId: subscriptionId,
        email: stripeCustomer.email,
        name: stripeCustomer.name,
        planName: invoice.lines?.data[0]?.description ?? 'Subscription',
        mrrCents: invoice.amount_due ?? 0,
        cancellationReason: 'Payment failed',
        cancellationCategory: 'Other',
        tier: 2,
        confidence: '0.90',
        status: 'pending',
        paymentMethodAtFailure: paymentMethodId,
      })
      .returning({ id: churnedSubscribers.id })

    subscriberId = newSub.id
  }

  // Get founder name for email
  const [user] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, customer.userId))
    .limit(1)
  const fromName = customer.founderName ?? user?.name ?? 'The team'

  // Determine next retry date
  const nextRetryDate = invoice.next_payment_attempt
    ? new Date(invoice.next_payment_attempt * 1000)
    : null

  await sendDunningEmail({
    subscriberId,
    email: stripeCustomer.email,
    customerName: stripeCustomer.name ?? null,
    planName: invoice.lines?.data[0]?.description ?? 'Subscription',
    amountDue: invoice.amount_due ?? 0,
    currency: invoice.currency ?? 'usd',
    nextRetryDate,
    fromName,
  })

  console.log('DUNNING EMAIL sent to:', stripeCustomer.email, 'amount:', invoice.amount_due)
}

async function processPaymentSucceeded(event: Stripe.Event) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoice = event.data.object as any
  const accountId = event.account

  if (!accountId) return
  if (!invoice.subscription) return

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.stripeAccountId, accountId))
    .limit(1)

  if (!customer) return

  const stripeCustomerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : (invoice.customer as Stripe.Customer)?.id ?? ''

  // Find subscriber with payment failed reason
  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.stripeCustomerId, stripeCustomerId),
        eq(churnedSubscribers.cancellationReason, 'Payment failed'),
        ne(churnedSubscribers.status, 'recovered')
      )
    )
    .limit(1)

  if (!subscriber) return // Not a dunning case

  // Determine attribution
  let attributionType: string | null = null

  // Spec 21b/22a — handoff & pause attribution window (highest priority)
  const HANDOFF_ATTRIBUTION_DAYS = 30
  if (subscriber.founderHandoffAt) {
    const daysSinceHandoff = Math.floor(
      (Date.now() - subscriber.founderHandoffAt.getTime()) / (1000 * 60 * 60 * 24)
    )
    if (daysSinceHandoff <= HANDOFF_ATTRIBUTION_DAYS) {
      attributionType = 'strong'
    }
  }

  if (!attributionType && subscriber.aiPausedAt) {
    const daysSincePause = Math.floor(
      (Date.now() - subscriber.aiPausedAt.getTime()) / (1000 * 60 * 60 * 24)
    )
    if (daysSincePause <= HANDOFF_ATTRIBUTION_DAYS) {
      attributionType = 'strong'
    }
  }

  if (!attributionType) {
    if (subscriber.billingPortalClickedAt) {
      // STRONG — they clicked our billing portal link
      attributionType = 'strong'
    } else {
      // Check if payment method changed
      const accessToken = decrypt(customer.stripeAccessToken!)
      const stripe = new Stripe(accessToken)
      const stripeCustomer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer
      const currentPM = stripeCustomer.invoice_settings?.default_payment_method
      const currentPMId = typeof currentPM === 'string' ? currentPM : currentPM?.id ?? null

      if (currentPMId !== subscriber.paymentMethodAtFailure) {
        // WEAK — payment method changed after our email
        attributionType = 'weak'
      } else {
        // Same card, Stripe retry worked — we didn't help
        console.log('Payment succeeded via Stripe retry (same card) — no attribution:', stripeCustomerId)
        return
      }
    }
  }

  await db.insert(recoveries).values({
    subscriberId: subscriber.id,
    customerId: customer.id,
    planMrrCents: subscriber.mrrCents,
    newStripeSubId: typeof invoice.subscription === 'string' ? invoice.subscription : null,
    attributionType,
    // Phase B — dunning recoveries are card saves: covered by the platform
    // fee, no per-recovery performance fee.
    recoveryType: 'card_save',
  })

  // Spec 21b — also resolve any pending handoff
  await db
    .update(churnedSubscribers)
    .set({
      status: 'recovered',
      founderHandoffResolvedAt: subscriber.founderHandoffAt && !subscriber.founderHandoffResolvedAt
        ? new Date()
        : subscriber.founderHandoffResolvedAt,
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriber.id))

  // Log recovery event
  logEvent({
    name: 'subscriber_recovered',
    customerId: customer.id,
    properties: {
      subscriberId: subscriber.id,
      attributionType,
      planMrrCents: subscriber.mrrCents,
      recoveryMethod: 'payment_succeeded',
    },
  })

  console.log(`${attributionType.toUpperCase()} DUNNING RECOVERY:`, subscriber.email)

  // Phase B — kick off platform-fee billing (no perf fee for card saves).
  await triggerActivation(customer.id, 'dunning_recovery')
}

/**
 * Spec 23 — Platform card capture handler.
 *
 * Fires when a Stripe Checkout session with mode='setup' completes on the
 * platform account (metadata.flow === 'platform_card_capture'). We:
 *   1. Retrieve the SetupIntent to get the attached payment method ID
 *   2. Check if the customer already had a default PM (→ Update flow)
 *   3. Set the new PM as the customer's default for invoice billing
 *   4. Detach the previous PM if this was an Update (don't accumulate)
 */
async function processPlatformCardCapture(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session
  const wbCustomerId = session.metadata?.winback_customer_id
  if (!wbCustomerId) {
    console.warn('[webhook] platform_card_capture without winback_customer_id metadata')
    return
  }

  const stripe = getStripe()

  const setupIntentId = typeof session.setup_intent === 'string'
    ? session.setup_intent
    : session.setup_intent?.id
  if (!setupIntentId) {
    console.warn('[webhook] platform_card_capture session has no setup_intent:', session.id)
    return
  }

  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId)
  const paymentMethodId = typeof setupIntent.payment_method === 'string'
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id
  if (!paymentMethodId) {
    console.warn('[webhook] setupIntent has no payment_method:', setupIntentId)
    return
  }

  const platformCustomerId = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id
  if (!platformCustomerId) {
    console.warn('[webhook] platform_card_capture session has no customer:', session.id)
    return
  }

  // Determine if this is Add or Update (previous PM present?)
  const previousPmId = await getCurrentDefaultPaymentMethodId(platformCustomerId, stripe)
  const wasUpdate = !!previousPmId && previousPmId !== paymentMethodId

  await setDefaultPaymentMethod(platformCustomerId, paymentMethodId)

  if (wasUpdate && previousPmId) {
    await detachPaymentMethod(previousPmId)
  }

  logEvent({
    name: 'billing_card_captured',
    customerId: wbCustomerId,
    properties: {
      paymentMethodId,
      stripeSessionId: session.id,
      wasUpdate,
    },
  })

  console.log(`[webhook] Platform card ${wasUpdate ? 'updated' : 'captured'} for customer ${wbCustomerId}`)

  // Phase B — converge on activation now that a card is on file. If a
  // recovery has already been delivered, this is the moment we create the
  // $99/mo Stripe Subscription and drain any queued win-back perf fees onto
  // its first invoice. No-op for an Update (subscription already exists).
  await triggerActivation(wbCustomerId, 'card_capture')
}

/**
 * Phase B — handle our own platform-side subscription cancellation. Fires
 * when Stripe ends the subscription (cancel_at_period_end reached, or the
 * customer cancelled directly via the billing portal). Just clears the
 * cached subscription_id so a future recovery can ensurePlatformSubscription
 * cleanly.
 */
async function processPlatformSubscriptionDeleted(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription
  const wbCustomerId = subscription.metadata?.winback_customer_id

  if (!wbCustomerId) {
    console.warn('[webhook] platform subscription.deleted without winback_customer_id metadata:', subscription.id)
    return
  }

  await db
    .update(customers)
    .set({ stripeSubscriptionId: null, updatedAt: new Date() })
    .where(eq(customers.id, wbCustomerId))

  logEvent({
    name: 'platform_subscription_canceled',
    customerId: wbCustomerId,
    properties: { stripeSubscriptionId: subscription.id },
  })

  console.log(`[webhook] Platform subscription canceled for customer ${wbCustomerId}`)
}

/**
 * Phase B/C — log-only handler for platform-side invoice events on the
 * Stripe Subscription. Stripe is the source of truth for invoice state;
 * we log paid/failed for observability and let Stripe Smart Retries handle
 * payment retries.
 */
async function processPlatformInvoiceEvent(event: Stripe.Event) {
  const invoice = event.data.object as Stripe.Invoice
  const invoiceId = invoice.id
  if (!invoiceId) return

  const wbCustomerId = invoice.metadata?.winback_customer_id ?? null
  const isPaid = event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded'
  const isFailed = event.type === 'invoice.payment_failed'

  if (isPaid) {
    logEvent({
      name: 'billing_invoice_paid',
      properties: {
        stripeInvoiceId: invoiceId,
        winbackCustomerId: wbCustomerId,
        amountCents: invoice.amount_paid,
      },
    })
    console.log(`[webhook] Platform invoice paid: ${invoiceId}`)
  } else if (isFailed) {
    logEvent({
      name: 'billing_invoice_failed',
      properties: {
        stripeInvoiceId: invoiceId,
        winbackCustomerId: wbCustomerId,
        failureReason:
          (invoice as Stripe.Invoice & { last_finalization_error?: { message?: string } })
            .last_finalization_error?.message ?? null,
      },
    })
    console.log(`[webhook] Platform invoice failed: ${invoiceId}`)

    // Notify the founder so they can update their card before Stripe's
    // retries are exhausted. Best-effort — never fails the webhook.
    if (wbCustomerId) {
      await sendPlatformPaymentFailedEmail({
        customerId: wbCustomerId,
        invoiceAmountCents: invoice.amount_due ?? 0,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      })
    }
  }
}

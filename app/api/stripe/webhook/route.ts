import Stripe from 'stripe'
import { db } from '@/lib/db'
import { users, customers, churnedSubscribers, recoveries, emailsSent } from '@/lib/schema'
import { eq, and, ne, inArray } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { extractSignals } from '@/src/winback/lib/stripe'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { scheduleExitEmail, sendDunningEmail } from '@/src/winback/lib/email'

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!)
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
    return new Response('Invalid signature', { status: 400 })
  }

  console.log('Webhook received:', event.type, 'account:', event.account ?? 'none')

  try {
    if (event.type === 'customer.subscription.deleted') {
      await processChurn(event)
    }
    if (event.type === 'customer.subscription.created') {
      await processRecovery(event)
    }
    if (event.type === 'checkout.session.completed') {
      await processCheckoutRecovery(event)
    }
    if (event.type === 'invoice.payment_failed') {
      await processPaymentFailed(event)
    }
    if (event.type === 'invoice.payment_succeeded') {
      await processPaymentSucceeded(event)
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
    console.log('Duplicate webhook, skipping')
    return
  }

  const decryptedToken = decrypt(customer.stripeAccessToken!)
  const signals = await extractSignals(subscription, decryptedToken)

  const classification = await classifySubscriber(signals, {
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
      winBackSubject: classification.winBackSubject,
      winBackBody: classification.winBackBody,
      status: classification.suppress ? 'lost' : 'pending',
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

  // Only count as weak recovery if we actually emailed them
  const [emailRecord] = await db
    .select({ id: emailsSent.id })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, churned.id))
    .limit(1)

  if (!emailRecord) {
    console.log('Resubscription but no emails sent — not counting as recovery:', churned.email)
    return
  }

  const planItem = subscription.items?.data[0]
  const mrrCents = planItem?.price?.unit_amount ?? 0
  const attributionEndsAt = new Date()
  attributionEndsAt.setFullYear(attributionEndsAt.getFullYear() + 1)

  await db.insert(recoveries).values({
    subscriberId: churned.id,
    customerId: customer.id,
    planMrrCents: mrrCents,
    newStripeSubId: subscription.id,
    attributionEndsAt,
    attributionType: 'weak',
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'recovered', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, churned.id))

  console.log('WEAK RECOVERY:', churned.email, 'at', mrrCents, 'cents/mo')
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
  const attributionEndsAt = new Date()
  attributionEndsAt.setFullYear(attributionEndsAt.getFullYear() + 1)

  await db.insert(recoveries).values({
    subscriberId,
    customerId,
    planMrrCents: mrrCents,
    newStripeSubId: session.subscription as string ?? null,
    attributionEndsAt,
    attributionType: 'strong',
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'recovered', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  console.log('STRONG RECOVERY:', subscriber.email, 'at', mrrCents, 'cents/mo')
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
  let attributionType: string

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

  const attributionEndsAt = new Date()
  attributionEndsAt.setFullYear(attributionEndsAt.getFullYear() + 1)

  await db.insert(recoveries).values({
    subscriberId: subscriber.id,
    customerId: customer.id,
    planMrrCents: subscriber.mrrCents,
    newStripeSubId: typeof invoice.subscription === 'string' ? invoice.subscription : null,
    attributionEndsAt,
    attributionType,
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'recovered', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriber.id))

  console.log(`${attributionType.toUpperCase()} DUNNING RECOVERY:`, subscriber.email)
}

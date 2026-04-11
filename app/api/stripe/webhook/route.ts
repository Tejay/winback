import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { extractSignals } from '@/src/winback/lib/stripe'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { scheduleExitEmail } from '@/src/winback/lib/email'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export async function POST(req: Request) {
  const rawBody = Buffer.from(await req.arrayBuffer())
  const sig = req.headers.get('stripe-signature') ?? ''

  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
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

  if (!classification.suppress && signals.email && customer.gmailRefreshToken) {
    const decryptedRefreshToken = decrypt(customer.gmailRefreshToken)
    await scheduleExitEmail({
      subscriberId: newSub.id,
      email: signals.email,
      classification,
      refreshToken: decryptedRefreshToken,
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
        inArray(churnedSubscribers.status, ['pending', 'contacted'])
      )
    )
    .limit(1)

  if (!churned) return

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
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'recovered', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, churned.id))

  console.log('RECOVERY:', churned.email, 'at', mrrCents, 'cents/mo')
}

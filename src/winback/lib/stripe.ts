import Stripe from 'stripe'
import { SubscriberSignals } from './types'

// Uses the CUSTOMER's OAuth access token — not our platform key
export async function extractSignals(
  subscription: Stripe.Subscription,
  accessToken: string
): Promise<SubscriberSignals> {
  const stripe = new Stripe(accessToken)

  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id

  const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer

  const startDate = subscription.start_date
    ? new Date(subscription.start_date * 1000)
    : new Date(subscription.created * 1000)
  const cancelledAt = subscription.canceled_at
    ? new Date(subscription.canceled_at * 1000)
    : new Date()

  const tenureDays = Math.floor(
    (cancelledAt.getTime() - startDate.getTime()) / 86400000
  )

  // current_period_end may not be in the type definition but exists on the API object
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subAny = subscription as any
  const currentPeriodEnd = typeof subAny.current_period_end === 'number'
    ? new Date(subAny.current_period_end * 1000)
    : null
  const nearRenewal = currentPeriodEnd
    ? Math.abs(cancelledAt.getTime() - currentPeriodEnd.getTime()) <= 3 * 86400000
    : false

  const invoices = await stripe.invoices.list({
    customer: customerId,
    limit: 100,
  })

  const priceIds = new Set<string>()
  let paymentFailures = 0
  for (const inv of invoices.data) {
    if (inv.lines?.data) {
      for (const line of inv.lines.data) {
        // Access price via any cast since Stripe SDK types vary by version
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lineAny = line as any
        const price = lineAny.price as { id?: string } | undefined
        if (price?.id) priceIds.add(price.id)
      }
    }
    if ((inv.attempt_count && inv.attempt_count > 1) || inv.status === 'uncollectible') {
      paymentFailures++
    }
  }

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  })

  const planItem = subscription.items?.data[0]
  const planName = planItem?.price?.nickname
    ?? planItem?.plan?.nickname
    ?? 'Unknown'
  const mrrCents = planItem?.price?.unit_amount ?? 0

  return {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: planItem?.price?.id ?? null,
    email: customer.email ?? null,
    name: customer.name ?? null,
    planName,
    mrrCents,
    tenureDays,
    everUpgraded: priceIds.size > 1,
    nearRenewal,
    paymentFailures,
    previousSubs: Math.max(0, subscriptions.data.length - 1),
    stripeEnum: subscription.cancellation_details?.feedback ?? null,
    stripeComment: subscription.cancellation_details?.comment ?? null,
    cancelledAt,
  }
}

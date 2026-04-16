import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { decrypt } from './encryption'
import { extractSignals } from './stripe'
import { classifySubscriber } from './classifier'
import { scheduleExitEmail } from './email'

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Backfill cancelled subscriptions from a connected Stripe account.
 * Pulls up to 1 year of history, inserts into DB, then classifies
 * each subscriber via AI. The AI decides whether to email or skip.
 *
 * First page (100) loads immediately for the aha moment.
 * Pagination continues in the same request.
 */
export async function backfillCancellations(customerId: string): Promise<void> {
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)

  if (!customer?.stripeAccessToken) {
    throw new Error(`Customer ${customerId} has no Stripe access token`)
  }

  const accessToken = decrypt(customer.stripeAccessToken)
  const stripe = new Stripe(accessToken)

  const oneYearAgo = new Date(Date.now() - ONE_YEAR_MS)

  // Mark backfill as started
  await db
    .update(customers)
    .set({ backfillStartedAt: new Date(), backfillTotal: 0, backfillProcessed: 0 })
    .where(eq(customers.id, customerId))

  // Paginate through all cancelled subscriptions
  const allSubscriptions: Stripe.Subscription[] = []
  let hasMore = true
  let startingAfter: string | undefined

  while (hasMore) {
    const params: Stripe.SubscriptionListParams = {
      status: 'canceled',
      limit: 100,
      expand: ['data.customer'],
    }
    if (startingAfter) params.starting_after = startingAfter

    const page = await stripe.subscriptions.list(params)

    for (const sub of page.data) {
      const cancelledAt = sub.canceled_at
        ? new Date(sub.canceled_at * 1000)
        : null

      // Stop if older than 1 year
      if (cancelledAt && cancelledAt < oneYearAgo) {
        hasMore = false
        break
      }

      allSubscriptions.push(sub)
    }

    if (hasMore) {
      hasMore = page.has_more
      if (page.data.length > 0) {
        startingAfter = page.data[page.data.length - 1].id
      }
    }

    // Update total count as we go
    await db
      .update(customers)
      .set({ backfillTotal: allSubscriptions.length })
      .where(eq(customers.id, customerId))
  }

  // Process each subscription: insert + classify
  for (const sub of allSubscriptions) {
    const stripeCustomer = sub.customer as Stripe.Customer
    const stripeCustomerId = typeof sub.customer === 'string'
      ? sub.customer
      : stripeCustomer.id

    // Idempotency: skip if already exists
    const existing = await db
      .select({ id: churnedSubscribers.id })
      .from(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.customerId, customerId),
          eq(churnedSubscribers.stripeCustomerId, stripeCustomerId)
        )
      )
      .limit(1)

    if (existing.length > 0) {
      await incrementProcessed(customerId)
      continue
    }

    try {
      // Extract signals
      const signals = await extractSignals(sub, accessToken)

      // Classify with AI
      const classification = await classifySubscriber(signals, {
        productName: customer.productName ?? undefined,
        founderName: customer.founderName ?? undefined,
        changelog: customer.changelogText ?? undefined,
      })

      // Determine status: if AI says suppress or cancellation is old, skip
      const shouldEmail = !classification.suppress && classification.firstMessage !== null
      const status = shouldEmail ? 'contacted' : 'skipped'

      // Insert subscriber
      const [inserted] = await db
        .insert(churnedSubscribers)
        .values({
          customerId,
          stripeCustomerId,
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
          status,
          source: 'backfill',
          cancelledAt: signals.cancelledAt,
        })
        .returning({ id: churnedSubscribers.id })

      // Send email if AI decided to contact
      if (shouldEmail && signals.email) {
        try {
          await scheduleExitEmail({
            subscriberId: inserted.id,
            email: signals.email,
            classification,
            fromName: customer.founderName ?? 'The team',
          })
        } catch (emailErr) {
          console.error(`Backfill email failed for ${signals.email}:`, emailErr)
          // Don't fail the whole backfill for one email error
        }
      }
    } catch (err) {
      console.error(`Backfill failed for subscription ${sub.id}:`, err)
      // Continue processing other subscriptions
    }

    await incrementProcessed(customerId)
  }

  // Mark backfill complete
  await db
    .update(customers)
    .set({ backfillCompletedAt: new Date() })
    .where(eq(customers.id, customerId))
}

async function incrementProcessed(customerId: string): Promise<void> {
  const [current] = await db
    .select({ backfillProcessed: customers.backfillProcessed })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)

  await db
    .update(customers)
    .set({ backfillProcessed: (current?.backfillProcessed ?? 0) + 1 })
    .where(eq(customers.id, customerId))
}

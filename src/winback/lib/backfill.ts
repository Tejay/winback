import Stripe from 'stripe'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { decrypt } from './encryption'
import { extractSignals } from './stripe'
import { classifySubscriber } from './classifier'
import { scheduleExitEmail } from './email'
import { ClassificationResult } from './types'

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** Only email backfill subscribers who cancelled within this window */
const BACKFILL_EMAIL_CUTOFF_DAYS = 7

/** Stripe enum → cancellationCategory mapping for deterministic classification */
const STRIPE_ENUM_TO_CATEGORY: Record<string, string> = {
  too_expensive: 'Price',
  missing_features: 'Feature',
  switched_service: 'Competitor',
  unused: 'Unused',
  customer_service: 'Quality',
  too_complex: 'Quality',
  low_quality: 'Quality',
  other: 'Other',
}

/**
 * Build a deterministic classification for silent churners (no stripeEnum, no stripeComment).
 * Saves an LLM call (~$0.003) for subscribers with no signal to interpret.
 */
function classifySilentChurn(): Omit<ClassificationResult, 'firstMessage'> & { firstMessage: null } {
  return {
    tier: 3,
    tierReason: 'Silent churn — no cancellation reason provided',
    cancellationReason: 'No reason given',
    cancellationCategory: 'Other',
    confidence: 0.3,
    suppress: false,
    firstMessage: null,
    triggerKeyword: null,
    triggerNeed: null,
    winBackSubject: '',
    winBackBody: '',
  }
}

/**
 * Returns true if the subscriber has actual signal data worth sending to the LLM.
 * Silent churners (no enum, no comment) don't need an LLM call.
 */
function hasSignalForLLM(signals: { stripeEnum: string | null; stripeComment: string | null }): boolean {
  return !!(signals.stripeEnum || signals.stripeComment)
}

/**
 * Backfill cancelled subscriptions from a connected Stripe account.
 * Pulls up to 1 year of history, inserts into DB, then classifies
 * each subscriber.
 *
 * Smart classification:
 * - Subscribers with stripeComment or stripeEnum → full LLM classify
 * - Silent churners (no signal) → deterministic defaults (no LLM call)
 *
 * Email rules:
 * - Cancelled < 7 days ago → email if LLM doesn't suppress
 * - Cancelled 7+ days ago → classify only, no email (wait for event triggers)
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
  const emailCutoff = new Date(Date.now() - BACKFILL_EMAIL_CUTOFF_DAYS * 24 * 60 * 60 * 1000)

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

      // Smart classification: only call LLM when there's actual signal
      let classification: ClassificationResult
      if (hasSignalForLLM(signals)) {
        classification = await classifySubscriber(signals, {
          productName: customer.productName ?? undefined,
          founderName: customer.founderName ?? undefined,
          changelog: customer.changelogText ?? undefined,
        })
        console.log('Backfill LLM classify:', signals.email, 'tier:', classification.tier)
      } else {
        classification = classifySilentChurn()
        console.log('Backfill deterministic classify (silent churn):', signals.email)
      }

      // Email rules:
      // - Only email if cancelled < 7 days ago AND LLM says to contact
      // - Older subscribers get classified but not emailed
      const isRecent = signals.cancelledAt >= emailCutoff
      const llmWantsToEmail = !classification.suppress && classification.firstMessage !== null
      const shouldEmail = isRecent && llmWantsToEmail && !!signals.email

      // Status logic:
      // - 'contacted' if we're going to email them
      // - 'skipped' if LLM suppressed (tier 4, no email address, etc.)
      // - 'pending' if classified but not emailed (older than 7 days) — eligible for changelog triggers
      let status: string
      if (shouldEmail) {
        status = 'contacted'
      } else if (classification.suppress) {
        status = 'skipped'
      } else {
        status = 'pending'
      }

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
          triggerNeed: classification.triggerNeed,
          winBackSubject: classification.winBackSubject,
          winBackBody: classification.winBackBody,
          status,
          source: 'backfill',
          fallbackDays: 90,
          cancelledAt: signals.cancelledAt,
        })
        .returning({ id: churnedSubscribers.id })

      // Send email only for recent cancellations that the AI approved
      if (shouldEmail) {
        try {
          await scheduleExitEmail({
            subscriberId: inserted.id,
            email: signals.email!,
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

// Exported for testing
export { hasSignalForLLM, classifySilentChurn, BACKFILL_EMAIL_CUTOFF_DAYS, STRIPE_ENUM_TO_CATEGORY }

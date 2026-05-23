import Stripe from 'stripe'
import { db } from '@/lib/db'
import { users, customers, churnedSubscribers, recoveries, emailsSent } from '@/lib/schema'
import { eq, and, ne, inArray, desc, isNull, isNotNull } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { extractSignals, getConnectStripe, getInvoiceSubscriptionId } from '@/src/winback/lib/stripe'
import { getPlatformStripe } from '@/src/winback/lib/platform-stripe'
// Spec 72 — classifier no longer runs inline in the webhook; rows are
// inserted with classified_at = NULL and the classifier cron picks them
// up. scheduleExitEmail moved with it (lives in classifier-tick.ts).
import { sendDunningEmail, buildFromDisplayName } from '@/src/winback/lib/email'
import { logEvent } from '@/src/winback/lib/events'
import {
  getCurrentDefaultPaymentMethodId,
  setDefaultPaymentMethod,
  detachPaymentMethod,
} from '@/src/winback/lib/platform-billing'
import { prepareActivation } from '@/src/winback/lib/activation'
import { syncBilledTierFromStripe } from '@/src/winback/lib/subscription'
import { takeSnapshot } from '@/src/winback/lib/mrr-snapshot'
import { sendPlatformPaymentFailedEmail } from '@/src/winback/lib/billing-notifications'
import { processDunningPaymentUpdate } from '@/src/winback/lib/dunning-checkout'

// Spec 62 — pinned Stripe client (platform-side). Wraps getPlatformStripe
// so the existing call sites (signature verification, retrievals) stay
// unchanged.
function getStripe() {
  return getPlatformStripe()
}

/**
 * Runs prepareActivation in a try/catch so a Stripe API blip never blocks
 * the recovery webhook from acknowledging. prepareActivation is idempotent;
 * a retry (Stripe redelivers, or a follow-up webhook) will reach the same
 * end state.
 *
 * NEVER creates the platform Stripe subscription on its own — that only
 * happens via commitActivation, which the customer triggers explicitly on
 * the activation confirmation page. Webhook only persists recommended_tier
 * + activatedAt and (when in 'enterprise_handoff') flips requires_sales.
 */
async function triggerActivation(wbCustomerId: string, ctx: string): Promise<void> {
  try {
    const result = await prepareActivation(wbCustomerId)
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
 * Fire-and-forget MRR snapshot for the customer behind a connect-side
 * subscription event. Drives the snapshot density that smoothing relies
 * on — without these, smoothed MRR would lag by up to a week between
 * scheduled cron runs.
 *
 * Resolution: connect account id → customers.id → takeSnapshot. Failures
 * are swallowed; the weekly cron is the safety net.
 */
async function maybeRecomputeMrr(accountId: string | undefined, ctx: string): Promise<void> {
  if (!accountId) return
  try {
    const [cust] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.stripeAccountId, accountId))
      .limit(1)
    if (!cust) return
    const result = await takeSnapshot(cust.id, 'webhook')
    if (!result.ok && result.reason !== 'no_token') {
      console.warn(`[mrr-snapshot:${ctx}] failed for`, cust.id, result.error ?? result.reason)
    }
  } catch (err) {
    console.error(`[mrr-snapshot:${ctx}] unexpected error for account`, accountId, err)
  }
}

export async function POST(req: Request) {
  const rawBody = Buffer.from(await req.arrayBuffer())
  const sig = req.headers.get('stripe-signature') ?? ''

  // Spec 47 — accept events from either the Connect webhook destination
  // (events from connected merchant accounts) or the platform webhook
  // destination (events on Winback's own account: $99/mo subscription
  // billing, platform card capture). Each destination has its own secret;
  // we try them in order and accept whichever verifies.
  let event: Stripe.Event | undefined
  let lastErr: unknown = null

  const secrets = [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_PLATFORM_WEBHOOK_SECRET,
  ].filter((s): s is string => !!s)

  for (const secret of secrets) {
    try {
      event = getStripe().webhooks.constructEvent(rawBody, sig, secret)
      lastErr = null
      break
    } catch (err) {
      lastErr = err
    }
  }

  if (!event) {
    console.error('Webhook signature failed:', lastErr)
    // Spec 26 — observability: emit so the overview's Errors counter
    // catches webhook-secret rotations and impersonation attempts. Source
    // IP helps distinguish "we rotated the secret" from real bad-actor.
    await logEvent({
      name: 'webhook_signature_invalid',
      properties: {
        sourceIp: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? null,
        errorMessage: lastErr instanceof Error ? lastErr.message : String(lastErr),
      },
    })
    return new Response('Invalid signature', { status: 400 })
  }

  console.log('Webhook received:', event.type, 'account:', event.account ?? 'none')

  try {
    if (event.type === 'customer.subscription.deleted') {
      if (event.account) {
        await processChurn(event)
        // Recompute MRR — a deletion shifts the customer's recurring base.
        await maybeRecomputeMrr(event.account, 'sub_deleted')
      } else {
        // Platform-side subscription canceled.
        await processPlatformSubscriptionDeleted(event)
      }
    }
    if (event.type === 'customer.subscription.created') {
      if (event.account) {
        await processRecovery(event)
        await maybeRecomputeMrr(event.account, 'sub_created')
      }
    }
    if (event.type === 'customer.subscription.updated') {
      if (event.account) {
        await maybeRecomputeMrr(event.account, 'sub_updated')
      } else {
        // Platform-side: sync billed_tier from the (possibly-changed) Price.
        await processPlatformSubscriptionUpdated(event)
      }
    }
    if (event.type === 'checkout.session.completed') {
      // Spec 23 — platform card capture (no event.account)
      // Spec 23 — reactivation checkout (event.account, winback_subscriber_id, no winback_flow)
      // Spec 35 — dunning update-payment (event.account, winback_flow='dunning_update_payment')
      const session = event.data.object as Stripe.Checkout.Session
      if (session.metadata?.flow === 'platform_card_capture') {
        await processPlatformCardCapture(event)
      } else if (session.metadata?.winback_flow === 'dunning_update_payment') {
        await processDunningPaymentUpdate(event)
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

  // Spec 28 — find-or-resend. If a row already exists for this subscriber,
  // we're seeing a Stripe redelivery (or a re-cancel). Branch on whether
  // the exit email actually went out:
  //   * email already sent  → return (or refund if within 14d window)
  //   * row exists, no email → re-classify and resend (the prior pass died
  //     between insert and email send)
  const [existing] = await db
    .select({
      id: churnedSubscribers.id,
      email: churnedSubscribers.email,
      status: churnedSubscribers.status,
    })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customer.id),
        eq(churnedSubscribers.stripeCustomerId, stripeCustomerId)
      )
    )
    .limit(1)

  if (existing) {
    // Spec 33 — if this subscriber was in the dunning sequence, clear
    // the state so the cron stops sending T2/T3. The subscription is
    // dead now; win-back path takes over.
    await db
      .update(churnedSubscribers)
      .set({
        dunningState: 'churned_during_dunning',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(churnedSubscribers.id, existing.id),
          isNotNull(churnedSubscribers.dunningState),
        ),
      )

    // Billing-rewrite: perf-fee refund machinery removed entirely. No
    // per-recovery charges → nothing to refund on a re-cancel. The
    // re-cancellation continues to flow through the dunning/winback
    // engines normally.

    // Did the exit email actually go out last time?
    const [sent] = await db
      .select({ id: emailsSent.id })
      .from(emailsSent)
      .where(
        and(
          eq(emailsSent.subscriberId, existing.id),
          eq(emailsSent.type, 'exit'),
        ),
      )
      .limit(1)

    if (sent) {
      // Happy path: row exists + email sent → done.
      return
    }
    if (existing.status === 'lost') {
      // Classifier suppressed last time and intentionally sent nothing.
      // Don't reclassify — that was the policy decision.
      return
    }
    // Row exists, no email — fall through to resend the email below.
    console.log('Resending exit email for stuck pending row:', existing.id)
  }

  // Spec 72 — webhook hot path drops the LLM call. Extract signals, insert
  // a raw row with classified_at = NULL, return. The classifier cron picks
  // it up within ~2 minutes and runs classification + exit-email send. If
  // the row already exists (Stripe redelivery, etc.), ON CONFLICT DO
  // NOTHING is a no-op — the classifier handles whatever state it's in.
  if (existing) {
    // Existing row + sent email → the dunning-state update above is the
    // only work needed. Done.
    // Existing row + no sent email + status != 'lost' → already in classifier
    // queue OR classifier already ran and the email send failed. Either way,
    // we don't re-classify here (would duplicate LLM cost). Admin can reset
    // via the inspector if a manual retry is needed.
    return
  }

  // First-time delivery — insert raw row and let the classifier cron run.
  const decryptedToken = decrypt(customer.stripeAccessToken!)
  const signals = await extractSignals(subscription, decryptedToken)

  const inserted = await db
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
      status: 'pending',          // classifier may refine to 'skipped' on tier 4
      fallbackDays: 90,
      cancelledAt: signals.cancelledAt,
      source: 'webhook',
      // classified_at intentionally NULL — classifier cron handles it next tick
    })
    .onConflictDoNothing()
    .returning({ id: churnedSubscribers.id })

  if (inserted.length > 0) {
    await logEvent({
      name: 'backfill_row_inserted',
      customerId: customer.id,
      properties: { subscriberId: inserted[0].id, source: 'webhook' },
    })
    console.log('Churned subscriber queued for classification:', inserted[0].id, signals.email)
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

  // Billing-rewrite: on a strong-attribution recovery, run prepareActivation
  // to (a) mark activatedAt, (b) compute the customer's MRR live and
  // persist recommended_tier so the in-app activation page can render the
  // breakdown the moment the customer visits. Subscription creation
  // remains gated on the customer's explicit click on the activation page.
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

/**
 * Phase D — dunning subscriber defaults.
 *
 * Failed-payment cases don't go through the LLM classifier (their cause is
 * always mechanical — card expired, declined, etc.) so we tier them as a
 * single homogenous group instead of guessing per-subscriber. Tier 2 = the
 * "send the standard retention email" lane; confidence 0.90 reflects that
 * the cause is well-understood, not that the recovery probability is.
 *
 * If you ever add a finer-grained dunning classifier (signal: tenure, MRR,
 * payment-failure history), replace these with its output and migrate.
 */
const DUNNING_TIER = 2 as const
const DUNNING_CONFIDENCE = '0.90' as const
const DUNNING_CATEGORY = 'Other' as const

async function processPaymentFailed(event: Stripe.Event) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoice = event.data.object as any
  const accountId = event.account

  if (!accountId) return
  // Spec 57 — invoice.subscription moved to invoice.parent.subscription_details.subscription
  // in Stripe API ≥ 2024-09-30. Helper handles both shapes.
  if (!getInvoiceSubscriptionId(invoice)) return // One-time payment, not our scope

  const attemptCount: number = invoice.attempt_count ?? 1
  const isFirstAttempt = attemptCount === 1

  // Spec 33 — derive dunning state from the invoice. Persisted on every
  // retry event so the daily dunning-followup cron can find rows whose
  // next retry is ~24h away.
  const nextRetryDate: Date | null = invoice.next_payment_attempt
    ? new Date(invoice.next_payment_attempt * 1000)
    : null

  const dunningState: 'awaiting_retry' | 'final_retry_pending' | 'churned_during_dunning' =
    !nextRetryDate
      ? 'churned_during_dunning'           // Stripe gave up after this attempt
      : attemptCount >= 3
      ? 'final_retry_pending'              // next retry is the last (default 4-attempt schedule)
      : 'awaiting_retry'                   // more retries coming

  // Spec 34 — capture the latest decline code so dunning email copy
  // can be specific to the failure reason. `decline_code` is the
  // bank-issued reason ('insufficient_funds', 'expired_card', etc.);
  // `code` is the higher-level Stripe bucket ('card_declined'). Prefer
  // the more specific one when available. Always overwritten on every
  // retry — banks may return different reasons across attempts.
  const lastPaymentError = invoice.last_payment_error ?? null
  const lastDeclineCode: string | null =
    lastPaymentError?.decline_code ?? lastPaymentError?.code ?? null

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.stripeAccountId, accountId))
    .limit(1)

  if (!customer) return

  const stripeCustomerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : (invoice.customer as Stripe.Customer)?.id ?? ''

  // Locate the subscriber row created on the first failure (if any).
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

  // Spec 33 — on retry events (attempt_count > 1) we don't send another
  // T1 email. We just refresh state so the cron can pick up T2/T3 later.
  // Spec 34 — also refresh lastDeclineCode (banks may give a different
  // reason across attempts; T2/T3 should reflect the latest known one).
  if (!isFirstAttempt) {
    if (existingSub) {
      await db
        .update(churnedSubscribers)
        .set({
          nextPaymentAttemptAt: nextRetryDate,
          dunningState,
          lastDeclineCode,
          updatedAt: new Date(),
        })
        .where(eq(churnedSubscribers.id, existingSub.id))
      console.log(
        '[dunning] state refresh attempt=', attemptCount,
        'state=', dunningState,
        'subscriberId=', existingSub.id,
      )
    } else {
      // Edge: we somehow missed attempt #1's webhook. Skip rather than
      // create a late row — sending T1 days late is worse than skipping.
      console.warn(
        '[dunning] retry event with no existing subscriber row — skipping',
        'stripeCustomer=', stripeCustomerId,
      )
    }
    return
  }

  // First-attempt idempotency: if we've already sent the T1 dunning email
  // (e.g. webhook re-delivery), skip.
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
      // Already sent T1; just refresh state in case the retry timestamp
      // (or decline reason — Spec 34) has shifted since the original event.
      await db
        .update(churnedSubscribers)
        .set({
          nextPaymentAttemptAt: nextRetryDate,
          dunningState,
          lastDeclineCode,
          updatedAt: new Date(),
        })
        .where(eq(churnedSubscribers.id, existingSub.id))
      console.log('Dunning email already sent for', stripeCustomerId)
      return
    }
  }

  // Get customer details from Stripe
  const accessToken = decrypt(customer.stripeAccessToken!)
  const stripe = getConnectStripe(accessToken)
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
    // Refresh state on the existing row even if T1 hasn't sent yet
    // (e.g. webhook re-delivery before T1 fired).
    await db
      .update(churnedSubscribers)
      .set({
        nextPaymentAttemptAt: nextRetryDate,
        dunningState,
        lastDeclineCode,
        updatedAt: new Date(),
      })
      .where(eq(churnedSubscribers.id, existingSub.id))
  } else {
    const subscriptionId = getInvoiceSubscriptionId(invoice) ?? ''

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
        cancellationCategory: DUNNING_CATEGORY,
        tier: DUNNING_TIER,
        confidence: DUNNING_CONFIDENCE,
        status: 'pending',
        paymentMethodAtFailure: paymentMethodId,
        // Spec 33 — initial dunning state machine.
        nextPaymentAttemptAt: nextRetryDate,
        dunningTouchCount: 1,
        dunningLastTouchAt: new Date(),
        dunningState,
        // Spec 34 — captured for the first T1.
        lastDeclineCode,
      })
      .returning({ id: churnedSubscribers.id })

    subscriberId = newSub.id
  }

  // Resolve display name for the From header + sign-off. Prefer the product
  // name (e.g. "Fitness App") so the subscriber recognises the brand they
  // signed up to; fall back to the founder name, then the user's account
  // name, then a generic.
  const [user] = await db
    .select({ name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, customer.userId))
    .limit(1)
  const fromName = buildFromDisplayName({
    founderName: customer.founderName ?? user?.name,
    productName: customer.productName,
  })

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
  // Spec 57 — invoice.subscription moved to invoice.parent.subscription_details.subscription
  // in Stripe API ≥ 2024-09-30. Helper handles both shapes.
  if (!getInvoiceSubscriptionId(invoice)) return

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
      const stripe = getConnectStripe(accessToken)
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
    // Spec 57 — read subscription id via helper (handles new + legacy API shapes)
    newStripeSubId: getInvoiceSubscriptionId(invoice),
    attributionType,
    // Dunning recoveries are card saves. Billing rewrite: no per-recovery
    // fee anywhere — the flat tier fee covers all recoveries. recoveryType
    // is kept for analytics + the ROI dashboard's strong/weak attribution
    // split.
    recoveryType: 'card_save',
  })

  // Spec 21b — also resolve any pending handoff
  // Spec 33 — clear dunning state so the cron skips this row going forward
  await db
    .update(churnedSubscribers)
    .set({
      status: 'recovered',
      founderHandoffResolvedAt: subscriber.founderHandoffAt && !subscriber.founderHandoffResolvedAt
        ? new Date()
        : subscriber.founderHandoffResolvedAt,
      dunningState: subscriber.dunningState ? 'recovered_during_dunning' : null,
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

  // Billing rewrite: a successful card-save counts as a delivered
  // recovery, so it triggers prepareActivation (mark activatedAt,
  // compute MRR, persist recommended_tier). The customer's banner and
  // activation page get hot for the next dashboard visit.
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

  // Billing rewrite: card-capture no longer auto-creates the platform
  // subscription. Subscription creation is gated on the customer's
  // explicit click on the /billing/activate page (commitActivation
  // route). This call only runs prepareActivation as a defensive
  // refresh — if the customer has a delivered recovery, it ensures
  // recommended_tier is current and activatedAt is set, so the
  // dashboard banner and activation page are hot whenever they revisit.
  await triggerActivation(wbCustomerId, 'card_capture')
}

/**
 * Handle our own platform-side subscription cancellation. Fires when
 * Stripe ends the subscription (cancel_at_period_end reached, or the
 * customer cancelled directly via the billing portal).
 *
 * Billing-rewrite behavior: reset the customer to pre_billing — clear
 * stripeSubscriptionId AND billed_tier so a future delivered recovery
 * re-prompts the activation confirmation page at whatever tier their
 * then-current MRR puts them in. recommendedTier is RETAINED (it's still
 * the right answer for what tier they SHOULD be on).
 */
async function processPlatformSubscriptionDeleted(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription
  const wbCustomerId = subscription.metadata?.winback_customer_id

  if (!wbCustomerId) {
    console.warn('[webhook] platform subscription.deleted without winback_customer_id metadata:', subscription.id)
    return
  }

  const now = new Date()
  await db
    .update(customers)
    .set({
      stripeSubscriptionId: null,
      billedTier: null,
      billedChangedAt: now,
      updatedAt: now,
    })
    .where(eq(customers.id, wbCustomerId))

  logEvent({
    name: 'platform_subscription_canceled',
    customerId: wbCustomerId,
    properties: { stripeSubscriptionId: subscription.id },
  })

  console.log(`[webhook] Platform subscription canceled for customer ${wbCustomerId}`)
}

/**
 * Platform-side subscription.updated. Most updates (status changes,
 * cancel_at_period_end toggles) need no DB action — Stripe is the source
 * of truth and we read it on demand. The one thing we DO sync is
 * billed_tier when the Price has changed (customer upgraded/downgraded
 * via the Stripe Customer Portal). syncBilledTierFromStripe handles the
 * reverse Price-ID → tier lookup.
 */
async function processPlatformSubscriptionUpdated(event: Stripe.Event) {
  const subscription = event.data.object as Stripe.Subscription
  const wbCustomerId = subscription.metadata?.winback_customer_id
  if (!wbCustomerId) return

  try {
    await syncBilledTierFromStripe(wbCustomerId, subscription)
  } catch (err) {
    console.error(
      '[webhook] platform subscription.updated tier-sync failed for',
      wbCustomerId,
      err,
    )
  }
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

// Billing-rewrite: removed processPromotionCodeUpsert / processCouponUpdated /
// processCouponDeleted. Those handlers existed only to feed the perf-fee
// promo machinery (applied_promotion_code_id on recoveries). With perf fees
// gone and the column dropped, ingesting Stripe promo codes serves no
// purpose. If platform-side coupon support is added later, write a new
// dedicated handler — don't resurrect this one.

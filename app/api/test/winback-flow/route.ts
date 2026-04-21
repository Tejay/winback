import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { decrypt } from '@/src/winback/lib/encryption'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import {
  matchChangelogToSubscribers,
  generateWinBackEmail,
} from '@/src/winback/lib/changelog-match'
import { appendStandardFooter } from '@/src/winback/lib/email'
import { buildHandoffNotification } from '@/src/winback/lib/founder-handoff-email'
import { logEvent } from '@/src/winback/lib/events'
import { SubscriberSignals } from '@/src/winback/lib/types'

/**
 * Provisions a real Stripe test customer + subscription on the connected
 * account so the resubscribe link in test emails actually works.
 *
 * The subscription is created in trial mode (no payment method needed) and
 * immediately marked `cancel_at_period_end: true` — so when the subscriber
 * clicks the resubscribe link, the reactivate route hits the resume path
 * (Strong recovery) and successfully redirects to /welcome-back?recovered=true.
 *
 * Returns null if Stripe operations fail (caller falls back to fake IDs +
 * a warning to the user).
 */
async function provisionStripeTestSubscription(
  stripe: Stripe,
  priceId: string,
  email: string,
  name: string,
): Promise<{ customerId: string; subscriptionId: string; priceId: string } | null> {
  try {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { winback_test_harness: 'true' },
    })

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: priceId }],
      trial_period_days: 30,
      cancel_at_period_end: true,
      metadata: { winback_test_harness: 'true' },
    })

    return {
      customerId: customer.id,
      subscriptionId: subscription.id,
      priceId,
    }
  } catch (err) {
    console.error('[test-harness] Stripe provisioning failed:', err)
    return null
  }
}

/**
 * Best-effort cleanup — deletes a Stripe test customer (which cancels their
 * subscriptions). Swallows errors since this is just hygiene.
 */
async function deleteStripeTestCustomer(stripe: Stripe, customerId: string): Promise<void> {
  try {
    await stripe.customers.del(customerId)
  } catch (err) {
    console.warn('[test-harness] Failed to delete Stripe test customer', customerId, err)
  }
}

/**
 * Wipes all test_harness subscribers (and their dependent rows) for a given
 * customer. Order matters because recoveries.subscriber_id has no cascade
 * (intentional — production recoveries should never disappear when a subscriber
 * row is removed). Returns the count of subscribers deleted.
 *
 * Also best-effort deletes Stripe customers if they were real (provisioned).
 */
async function wipeTestSubscribers(stripe: Stripe | null, customerId: string): Promise<number> {
  const existing = await db
    .select({ id: churnedSubscribers.id, stripeCustomerId: churnedSubscribers.stripeCustomerId })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, customerId),
        eq(churnedSubscribers.source, TEST_SOURCE),
      )
    )

  if (existing.length === 0) return 0

  const ids = existing.map(e => e.id)

  // Delete recoveries first (no cascade)
  await db.delete(recoveries).where(inArray(recoveries.subscriberId, ids))

  // Delete subscribers (emailsSent has cascade so it goes too)
  await db.delete(churnedSubscribers).where(inArray(churnedSubscribers.id, ids))

  // Best-effort Stripe cleanup for real (non-fake) customer IDs
  if (stripe) {
    for (const sub of existing) {
      if (sub.stripeCustomerId.startsWith('cus_') && !sub.stripeCustomerId.startsWith('cus_test_')) {
        await deleteStripeTestCustomer(stripe, sub.stripeCustomerId)
      }
    }
  }

  return existing.length
}

/**
 * Dev-only test harness for the full winback funnel.
 * Restricted to tejaasvi@gmail.com.
 *
 * Actions (POST { action: '...' }):
 *  - seed       — create 4 churned subscribers with different cancel reasons,
 *                 classify each, return classification + would-be exit email
 *  - reply      — { subscriberId, replyText } simulate a reply, re-classify,
 *                 return new classification + would-be follow-up email
 *  - changelog  — { changelogText } run matcher + email generator across all
 *                 test subscribers, return matched IDs + generated emails
 *  - reset      — delete all test subscribers
 *
 * GET — returns current state of all test subscribers
 *
 * IMPORTANT: This endpoint does NOT send real emails. It only runs the
 * classifier and email generator and returns the content for inspection.
 */

const TEST_SOURCE = 'test_harness'

const SCENARIOS = [
  {
    label: 'Alice — Price',
    email: 'test-price@winback-harness.local',
    name: 'Alice Price',
    planName: 'Pro',
    mrrCents: 2900,
    tenureDays: 95,
    stripeEnum: 'too_expensive',
    stripeComment: "Honestly $29/mo is a lot for what I use it for. Maybe $9/mo would work better.",
  },
  {
    label: 'Bob — Feature',
    email: 'test-feature@winback-harness.local',
    name: 'Bob Feature',
    planName: 'Starter',
    mrrCents: 1900,
    tenureDays: 47,
    stripeEnum: 'missing_features',
    stripeComment: "I really need CSV export to send data to my accountant. Without it, this just doesn't work for my workflow.",
  },
  {
    label: 'Carol — Competitor',
    email: 'test-competitor@winback-harness.local',
    name: 'Carol Competitor',
    planName: 'Pro',
    mrrCents: 4900,
    tenureDays: 220,
    stripeEnum: 'switched_service',
    stripeComment: 'Switched to Linear because it integrates better with our Slack and Notion setup.',
  },
  {
    label: 'Dave — Quality',
    email: 'test-quality@winback-harness.local',
    name: 'Dave Quality',
    planName: 'Starter',
    mrrCents: 1900,
    tenureDays: 12,
    stripeEnum: 'too_complex',
    stripeComment: 'The dashboard kept crashing for me on Safari. Tried it twice and gave up.',
  },
  {
    label: 'Eve — Human ask',
    email: 'test-handoff@winback-harness.local',
    name: 'Eve Human-ask',
    planName: 'Pro',
    mrrCents: 9900,
    tenureDays: 340,
    stripeEnum: 'other',
    stripeComment: "Can I talk to your founder before I go? We're evaluating a move to annual billing and I need to know what custom pricing and SOC 2 timelines look like — not something a bot can answer.",
  },
]

async function requireDevAuth() {
  // Hard refuse in production — this is a dev-only test harness
  if (process.env.NODE_ENV === 'production' && process.env.VERCEL_ENV !== 'preview') {
    return { error: 'This endpoint is disabled in production', status: 403 } as const
  }
  const session = await auth()
  if (!session?.user?.id) {
    return { error: 'Not signed in', status: 401 } as const
  }
  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return { error: 'No customer record found for this user — finish onboarding first', status: 404 } as const
  }
  return { customer } as const
}

function buildSignals(scenario: typeof SCENARIOS[number], stripeCustomerId: string): SubscriberSignals {
  return {
    stripeCustomerId,
    stripeSubscriptionId: `test_sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    stripePriceId: null,
    email: scenario.email,
    name: scenario.name,
    planName: scenario.planName,
    mrrCents: scenario.mrrCents,
    tenureDays: scenario.tenureDays,
    everUpgraded: false,
    nearRenewal: false,
    paymentFailures: 0,
    previousSubs: 0,
    stripeEnum: scenario.stripeEnum,
    stripeComment: scenario.stripeComment,
    cancelledAt: new Date(),
    emailsSent: 0,  // initial churn — nothing sent yet
  }
}

export async function GET() {
  const ctx = await requireDevAuth()
  if ('error' in ctx) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status })
  }

  const subs = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.customerId, ctx.customer.id),
        eq(churnedSubscribers.source, TEST_SOURCE),
      )
    )

  return NextResponse.json({
    customer: {
      id: ctx.customer.id,
      founderName: ctx.customer.founderName,
      productName: ctx.customer.productName,
    },
    subscribers: subs.map(s => ({
      id: s.id,
      email: s.email,
      name: s.name,
      planName: s.planName,
      mrrCents: s.mrrCents,
      stripeEnum: s.stripeEnum,
      stripeComment: s.stripeComment,
      replyText: s.replyText,
      cancellationReason: s.cancellationReason,
      cancellationCategory: s.cancellationCategory,
      tier: s.tier,
      confidence: s.confidence,
      triggerKeyword: s.triggerKeyword,
      triggerNeed: s.triggerNeed,
      winBackSubject: s.winBackSubject,
      winBackBody: s.winBackBody,
      status: s.status,
      createdAt: s.createdAt,
    })),
  })
}

export async function POST(req: Request) {
  try {
    return await handlePost(req)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    console.error('[test-harness] POST handler error:', message, stack)
    return NextResponse.json({ error: `Server error: ${message}`, stack }, { status: 500 })
  }
}

async function handlePost(req: Request) {
  const session = await requireDevAuth()
  if ('error' in session) {
    return NextResponse.json({ error: session.error }, { status: session.status })
  }
  const customer = session.customer

  const body = await req.json().catch(() => ({}))
  const action = body.action as string | undefined

  // Initialize Stripe once if the customer is connected — used by seed (provision)
  // and reset (cleanup). Falls back to null if not connected.
  const stripe: Stripe | null = customer.stripeAccessToken
    ? new Stripe(decrypt(customer.stripeAccessToken))
    : null

  if (action === 'reset') {
    const deletedCount = await wipeTestSubscribers(stripe, customer.id)
    return NextResponse.json({ ok: true, deleted: deletedCount })
  }

  if (action === 'seed') {
    // Wipe existing test subs (and their recoveries + Stripe customers) first
    await wipeTestSubscribers(stripe, customer.id)

    // Look up an active recurring price on the connected account, or create
    // a Winback-tagged test one on the fly if none exists. Tagged prices +
    // products make them easy to identify and clean up later.
    let priceId: string | null = null
    let stripeWarning: string | null = null
    if (stripe) {
      try {
        const prices = await stripe.prices.list({ active: true, type: 'recurring', limit: 10 })
        // Prefer an existing Winback-harness price (we created it before)
        const harnessPrice = prices.data.find(p => p.metadata?.winback_test_harness === 'true')
        if (harnessPrice) {
          priceId = harnessPrice.id
        } else if (prices.data[0]?.id) {
          priceId = prices.data[0].id
        } else {
          // No prices exist — auto-create a Winback-tagged test product + price
          // so the harness works end-to-end (reactivation links actually work).
          const product = await stripe.products.create({
            name: 'Winback Test Product',
            description: 'Auto-created by the Winback dev test harness. Safe to delete.',
            metadata: { winback_test_harness: 'true' },
          })
          const price = await stripe.prices.create({
            product: product.id,
            currency: 'usd',
            unit_amount: 2900,  // $29/mo — typical SaaS price
            recurring: { interval: 'month' },
            metadata: { winback_test_harness: 'true' },
          })
          priceId = price.id
          stripeWarning = 'Auto-created a Winback test product + price on your connected Stripe account (tagged; safe to delete).'
        }
      } catch (err) {
        stripeWarning = `Stripe price lookup/create failed (${err instanceof Error ? err.message : 'unknown'}) — falling back to fake IDs`
      }
    } else {
      stripeWarning = 'Customer has no Stripe access token — using fake IDs (resubscribe link will fail)'
    }

    const results = []
    for (const scenario of SCENARIOS) {
      // Try to provision real Stripe customer + subscription. Fall back to fake IDs.
      let stripeCustomerId: string
      let stripeSubscriptionId: string
      let stripePriceId: string | null = null
      let provisionedReal = false

      if (stripe && priceId) {
        const provisioned = await provisionStripeTestSubscription(
          stripe,
          priceId,
          scenario.email,
          scenario.name,
        )
        if (provisioned) {
          stripeCustomerId = provisioned.customerId
          stripeSubscriptionId = provisioned.subscriptionId
          stripePriceId = provisioned.priceId
          provisionedReal = true
        } else {
          stripeCustomerId = `cus_test_${scenario.label.split(' ')[0].toLowerCase()}_${Date.now()}`
          stripeSubscriptionId = `sub_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        }
      } else {
        stripeCustomerId = `cus_test_${scenario.label.split(' ')[0].toLowerCase()}_${Date.now()}`
        stripeSubscriptionId = `sub_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      }

      const signals = buildSignals(scenario, stripeCustomerId)
      // Override the placeholder subscription ID built by buildSignals with the real one
      signals.stripeSubscriptionId = stripeSubscriptionId
      signals.stripePriceId = stripePriceId
      let classification
      let classifyError = null
      try {
        classification = await classifySubscriber(signals, {
          founderName: customer.founderName ?? undefined,
          productName: customer.productName ?? undefined,
          changelog: customer.changelogText ?? undefined,
        })
      } catch (err) {
        classifyError = err instanceof Error ? err.message : String(err)
        results.push({ scenario: scenario.label, error: classifyError })
        continue
      }

      const [inserted] = await db
        .insert(churnedSubscribers)
        .values({
          customerId: customer.id,
          stripeCustomerId,
          stripeSubscriptionId: signals.stripeSubscriptionId,
          stripePriceId,
          email: scenario.email,
          name: scenario.name,
          planName: scenario.planName,
          mrrCents: scenario.mrrCents,
          tenureDays: scenario.tenureDays,
          stripeEnum: scenario.stripeEnum,
          stripeComment: scenario.stripeComment,
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
          source: TEST_SOURCE,
          fallbackDays: 90,
          cancelledAt: signals.cancelledAt,
        })
        .returning({ id: churnedSubscribers.id })

      results.push({
        scenario: scenario.label,
        subscriberId: inserted.id,
        stripeProvisioned: provisionedReal,
        stripeCustomerId,
        stripeSubscriptionId,
        signals: {
          email: scenario.email,
          stripeEnum: scenario.stripeEnum,
          stripeComment: scenario.stripeComment,
        },
        classification: {
          tier: classification.tier,
          tierReason: classification.tierReason,
          cancellationReason: classification.cancellationReason,
          cancellationCategory: classification.cancellationCategory,
          confidence: classification.confidence,
          suppress: classification.suppress,
          triggerKeyword: classification.triggerKeyword,
          triggerNeed: classification.triggerNeed,
          handoff:            classification.handoff,
          handoffReasoning:   classification.handoffReasoning,
          recoveryLikelihood: classification.recoveryLikelihood,
        },
        handoffNotification: classification.handoff
          ? await buildHandoffNotification({
              subscriber: {
                id: inserted.id,
                email: scenario.email,
                name: scenario.name,
                planName: scenario.planName,
                mrrCents: scenario.mrrCents,
                cancellationReason: classification.cancellationReason,
                triggerNeed: classification.triggerNeed,
                cancelledAt: signals.cancelledAt,
                stripeComment: scenario.stripeComment,
                replyText: null,
              },
              founderName: customer.founderName ?? 'The team',
              handoffReasoning:   classification.handoffReasoning,
              recoveryLikelihood: classification.recoveryLikelihood,
            })
          : null,
        exitEmail: classification.firstMessage
          ? {
              subject: classification.firstMessage.subject,
              body: appendStandardFooter(
                classification.firstMessage.body,
                inserted.id,
                customer.founderName ?? 'The team',
              ),
            }
          : null,
      })
    }

    return NextResponse.json({ ok: true, results, stripeWarning })
  }

  if (action === 'simulate-recovery') {
    // Harness v2 — inserts a wb_recoveries row directly with the chosen
    // attribution type. Shortcuts the real Stripe checkout flow. Used to
    // unlock end-to-end testing of:
    //   - 30-day attribution window (spec 21b / 22a)
    //   - Monthly billing cron (spec 24a — only strong recoveries bill)
    //   - Dashboard AI state + stats calculations
    const subscriberId = body.subscriberId as string
    const attributionType = body.attributionType as 'strong' | 'weak' | 'organic'
    if (!subscriberId || !['strong', 'weak', 'organic'].includes(attributionType)) {
      return NextResponse.json({ error: 'subscriberId + attributionType (strong/weak/organic) required' }, { status: 400 })
    }

    const [sub] = await db
      .select()
      .from(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.id, subscriberId),
          eq(churnedSubscribers.customerId, customer.id),
          eq(churnedSubscribers.source, TEST_SOURCE),
        )
      )
      .limit(1)
    if (!sub) {
      return NextResponse.json({ error: 'Test subscriber not found' }, { status: 404 })
    }
    if (sub.status === 'recovered') {
      return NextResponse.json({ error: 'Already recovered' }, { status: 400 })
    }

    // Insert synthetic recovery row. Matches the shape of real recoveries
    // from processRecovery/processCheckoutRecovery so billing + attribution
    // logic sees it identically.
    const attributionEndsAt = new Date()
    attributionEndsAt.setFullYear(attributionEndsAt.getFullYear() + 1)

    const [recovery] = await db
      .insert(recoveries)
      .values({
        subscriberId: sub.id,
        customerId: customer.id,
        planMrrCents: sub.mrrCents,
        newStripeSubId: null,   // synthetic — no real Stripe sub
        attributionEndsAt,
        attributionType,
        stillActive: true,
      })
      .returning({ id: recoveries.id })

    await db
      .update(churnedSubscribers)
      .set({
        status: 'recovered',
        // Resolve any pending handoff (spec 21b behavior — recovery ends handoff)
        founderHandoffResolvedAt: sub.founderHandoffAt && !sub.founderHandoffResolvedAt
          ? new Date()
          : sub.founderHandoffResolvedAt,
        updatedAt: new Date(),
      })
      .where(eq(churnedSubscribers.id, sub.id))

    logEvent({
      name: 'subscriber_recovered',
      customerId: customer.id,
      properties: {
        subscriberId: sub.id,
        attributionType,
        planMrrCents: sub.mrrCents,
        recoveryMethod: 'test_harness_simulate',
      },
    })

    return NextResponse.json({
      ok: true,
      recoveryId: recovery.id,
      attributionType,
      planMrrCents: sub.mrrCents,
      billableForInvoice: attributionType === 'strong',
    })
  }

  if (action === 'reply') {
    const subscriberId = body.subscriberId as string
    const replyText = body.replyText as string
    // Optional — lets harness users tell the classifier how many emails have
    // notionally gone out so the budget-awareness factor can kick in. Default
    // to 1 (the exit email would have been sent before the first reply).
    const rawEmailsSent = Number(body.emailsSent)
    const emailsSentSignal = Number.isFinite(rawEmailsSent) && rawEmailsSent >= 0
      ? Math.min(rawEmailsSent, 3)
      : 1
    if (!subscriberId || !replyText) {
      return NextResponse.json({ error: 'subscriberId and replyText required' }, { status: 400 })
    }

    const [sub] = await db
      .select()
      .from(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.id, subscriberId),
          eq(churnedSubscribers.customerId, customer.id),
          eq(churnedSubscribers.source, TEST_SOURCE),
        )
      )
      .limit(1)

    if (!sub) {
      return NextResponse.json({ error: 'Test subscriber not found' }, { status: 404 })
    }

    const signals: SubscriberSignals = {
      stripeCustomerId: sub.stripeCustomerId,
      stripeSubscriptionId: sub.stripeSubscriptionId ?? '',
      stripePriceId: sub.stripePriceId ?? null,
      email: sub.email,
      name: sub.name,
      planName: sub.planName ?? 'Unknown',
      mrrCents: sub.mrrCents,
      tenureDays: sub.tenureDays ?? 0,
      everUpgraded: sub.everUpgraded ?? false,
      nearRenewal: sub.nearRenewal ?? false,
      paymentFailures: sub.paymentFailures ?? 0,
      previousSubs: sub.previousSubs ?? 0,
      stripeEnum: sub.stripeEnum,
      stripeComment: sub.stripeComment,
      replyText,
      billingPortalClicked: !!sub.billingPortalClickedAt,
      cancelledAt: sub.cancelledAt ?? new Date(),
      emailsSent: emailsSentSignal,
    }

    let classification
    try {
      classification = await classifySubscriber(signals, {
        founderName: customer.founderName ?? undefined,
        productName: customer.productName ?? undefined,
        changelog: customer.changelogText ?? undefined,
      })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
    }

    await db
      .update(churnedSubscribers)
      .set({
        replyText,
        tier: classification.tier,
        confidence: String(classification.confidence),
        cancellationReason: classification.cancellationReason,
        cancellationCategory: classification.cancellationCategory,
        triggerKeyword: classification.triggerKeyword,
        triggerNeed: classification.triggerNeed,
        winBackSubject: classification.winBackSubject,
        winBackBody: classification.winBackBody,
        handoffReasoning:   classification.handoffReasoning,
        recoveryLikelihood: classification.recoveryLikelihood,
        updatedAt: new Date(),
      })
      .where(eq(churnedSubscribers.id, subscriberId))

    const replyMessage =
      classification.firstMessage ??
      (classification.winBackBody
        ? { subject: classification.winBackSubject, body: classification.winBackBody, sendDelaySecs: 0 }
        : null)

    // If the classifier decided to hand off, render the founder notification
    // so the harness user can see what would land in the founder's inbox.
    const handoffNotification = classification.handoff
      ? await buildHandoffNotification({
          subscriber: {
            id: sub.id,
            email: sub.email,
            name: sub.name,
            planName: sub.planName,
            mrrCents: sub.mrrCents,
            cancellationReason: classification.cancellationReason,
            triggerNeed: classification.triggerNeed,
            cancelledAt: sub.cancelledAt,
            stripeComment: sub.stripeComment,
            replyText,
          },
          founderName: customer.founderName ?? 'The team',
          handoffReasoning:   classification.handoffReasoning,
          recoveryLikelihood: classification.recoveryLikelihood,
        })
      : null

    return NextResponse.json({
      ok: true,
      emailsSentSignal,
      reclassification: {
        tier: classification.tier,
        tierReason: classification.tierReason,
        cancellationReason: classification.cancellationReason,
        cancellationCategory: classification.cancellationCategory,
        confidence: classification.confidence,
        triggerKeyword: classification.triggerKeyword,
        triggerNeed: classification.triggerNeed,
        handoff:            classification.handoff,
        handoffReasoning:   classification.handoffReasoning,
        recoveryLikelihood: classification.recoveryLikelihood,
      },
      handoffNotification,
      // Follow-up email is suppressed in production when handoff=true — mirror
      // that here so the harness accurately reflects the runtime behaviour.
      followUpEmail: classification.handoff
        ? null
        : replyMessage
          ? {
              subject: replyMessage.subject.startsWith('Re:') ? replyMessage.subject : `Re: ${replyMessage.subject}`,
              body: appendStandardFooter(
                replyMessage.body,
                subscriberId,
                customer.founderName ?? 'The team',
              ),
            }
          : null,
      followUpSkipped: classification.handoff || classification.tier === 4 || !replyMessage,
      followUpSkipReason: classification.handoff
        ? 'AI decided hand-off — founder notification sent instead'
        : classification.tier === 4
          ? 'Tier 4 — suppress'
          : !replyMessage
            ? 'No firstMessage generated'
            : null,
    })
  }

  if (action === 'changelog') {
    const changelogText = body.changelogText as string
    if (!changelogText) {
      return NextResponse.json({ error: 'changelogText required' }, { status: 400 })
    }

    const subs = await db
      .select()
      .from(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.customerId, customer.id),
          eq(churnedSubscribers.source, TEST_SOURCE),
        )
      )

    const candidates = subs
      .filter(s => s.triggerNeed || s.triggerKeyword)
      .map(s => ({
        id: s.id,
        need: (s.triggerNeed ?? s.triggerKeyword) as string,
      }))

    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, candidatesCount: 0, matchedIds: [], emails: [] })
    }

    const matchedIds = await matchChangelogToSubscribers(changelogText, candidates)

    const fromName = customer.founderName ?? 'The team'
    const emails: Array<{
      subscriberId: string
      subscriberName: string | null
      need: string
      generated: { subject: string; body: string } | null
    }> = []

    for (const sub of subs) {
      if (!matchedIds.has(sub.id)) continue
      const need = sub.triggerNeed ?? sub.triggerKeyword ?? ''
      const generated = need
        ? await generateWinBackEmail({
            changelogText,
            triggerNeed: need,
            subscriberName: sub.name,
            founderName: fromName,
          })
        : null
      emails.push({
        subscriberId: sub.id,
        subscriberName: sub.name,
        need,
        generated: generated
          ? {
              subject: generated.subject,
              body: appendStandardFooter(generated.body, sub.id, fromName),
            }
          : null,
      })
    }

    // Show what each candidate's outcome was
    const verdicts = candidates.map(c => {
      const sub = subs.find(s => s.id === c.id)!
      return {
        subscriberId: c.id,
        subscriberName: sub.name,
        need: c.need,
        matched: matchedIds.has(c.id),
      }
    })

    return NextResponse.json({
      ok: true,
      candidatesCount: candidates.length,
      matchedCount: matchedIds.size,
      verdicts,
      emails,
    })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

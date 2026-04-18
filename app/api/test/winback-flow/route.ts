import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import {
  matchChangelogToSubscribers,
  generateWinBackEmail,
} from '@/src/winback/lib/changelog-match'
import { SubscriberSignals } from '@/src/winback/lib/types'

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
  const session = await requireDevAuth()
  if ('error' in session) {
    return NextResponse.json({ error: session.error }, { status: session.status })
  }
  const customer = session.customer

  const body = await req.json().catch(() => ({}))
  const action = body.action as string | undefined

  if (action === 'reset') {
    const deleted = await db
      .delete(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.customerId, customer.id),
          eq(churnedSubscribers.source, TEST_SOURCE),
        )
      )
      .returning({ id: churnedSubscribers.id })
    return NextResponse.json({ ok: true, deleted: deleted.length })
  }

  if (action === 'seed') {
    // Wipe existing test subs first
    await db
      .delete(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.customerId, customer.id),
          eq(churnedSubscribers.source, TEST_SOURCE),
        )
      )

    const results = []
    for (const scenario of SCENARIOS) {
      const stripeCustomerId = `cus_test_${scenario.label.split(' ')[0].toLowerCase()}_${Date.now()}`
      const signals = buildSignals(scenario, stripeCustomerId)
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
          stripePriceId: null,
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
          status: classification.suppress ? 'lost' : 'pending',
          source: TEST_SOURCE,
          fallbackDays: 90,
          cancelledAt: signals.cancelledAt,
        })
        .returning({ id: churnedSubscribers.id })

      results.push({
        scenario: scenario.label,
        subscriberId: inserted.id,
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
        },
        exitEmail: classification.firstMessage
          ? {
              subject: classification.firstMessage.subject,
              body: classification.firstMessage.body,
            }
          : null,
      })
    }

    return NextResponse.json({ ok: true, results })
  }

  if (action === 'reply') {
    const subscriberId = body.subscriberId as string
    const replyText = body.replyText as string
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
        updatedAt: new Date(),
      })
      .where(eq(churnedSubscribers.id, subscriberId))

    const replyMessage =
      classification.firstMessage ??
      (classification.winBackBody
        ? { subject: classification.winBackSubject, body: classification.winBackBody, sendDelaySecs: 0 }
        : null)

    return NextResponse.json({
      ok: true,
      reclassification: {
        tier: classification.tier,
        tierReason: classification.tierReason,
        cancellationReason: classification.cancellationReason,
        cancellationCategory: classification.cancellationCategory,
        confidence: classification.confidence,
        triggerKeyword: classification.triggerKeyword,
        triggerNeed: classification.triggerNeed,
      },
      followUpEmail: replyMessage
        ? { subject: replyMessage.subject, body: replyMessage.body }
        : null,
      followUpSkipped: classification.tier === 4 || !replyMessage,
      followUpSkipReason: classification.tier === 4 ? 'Tier 4 — suppress' : !replyMessage ? 'No firstMessage generated' : null,
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
        generated,
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

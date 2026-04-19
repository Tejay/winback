import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { churnedSubscribers, customers, emailsSent } from '@/lib/schema'
import { eq, and, lt, lte, isNotNull, isNull, inArray, sql } from 'drizzle-orm'
import { classifySubscriber } from '@/src/winback/lib/classifier'
import { sendEmail, isCustomerPausedForSubscriber } from '@/src/winback/lib/email'
import { SubscriberSignals } from '@/src/winback/lib/types'
import { logEvent } from '@/src/winback/lib/events'

export const maxDuration = 60

/**
 * Daily cron job — re-engages subscribers whose 90-day fallback window has elapsed.
 *
 * Only contacts subscribers who:
 * - Were emailed previously (status = 'contacted') or pending with real-time source
 * - Haven't been re-engaged before (reengagement_count < 1)
 * - Haven't opted out (do_not_contact = false)
 * - Have an email address
 * - Cancelled at least fallback_days ago
 *
 * Each subscriber gets a fresh LLM re-classification with current context
 * (changelog, elapsed time). If the AI says suppress, we mark them done
 * without sending.
 *
 * Schedule: daily at 09:00 UTC via vercel.json
 */
export async function GET(req: NextRequest) {
  // Verify this is called by Vercel Cron (or internal trigger)
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Find eligible subscribers: 90-day fallback window has elapsed.
  // Spec 21b — skip subscribers who've been handed off to the founder.
  const eligible = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        inArray(churnedSubscribers.status, ['pending', 'contacted']),
        isNotNull(churnedSubscribers.fallbackDays),
        lt(churnedSubscribers.reengagementCount, 1),
        eq(churnedSubscribers.doNotContact, false),
        isNotNull(churnedSubscribers.email),
        isNull(churnedSubscribers.founderHandoffAt),
        // Spec 22a — respect per-subscriber AI pause
        sql`(${churnedSubscribers.aiPausedUntil} IS NULL OR ${churnedSubscribers.aiPausedUntil} < now())`,
        sql`${churnedSubscribers.cancelledAt} + (${churnedSubscribers.fallbackDays} || ' days')::interval <= now()`
      )
    )
    .limit(50)

  // Spec 21a — engaged-but-silent nudge query.
  // Subscribers who replied (or clicked) ≥ 7 days ago and have not been
  // proactively nudged. Different cohort from the 90-day backstop.
  const ENGAGED_NUDGE_DAYS = 7
  const engagedNudgeCutoff = new Date(Date.now() - ENGAGED_NUDGE_DAYS * 24 * 60 * 60 * 1000)

  const engagedNudgeCandidates = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.status, 'contacted'),
        eq(churnedSubscribers.doNotContact, false),
        isNotNull(churnedSubscribers.email),
        isNotNull(churnedSubscribers.lastEngagementAt),
        isNull(churnedSubscribers.proactiveNudgeAt),
        isNull(churnedSubscribers.founderHandoffAt),
        // Spec 22a — respect per-subscriber AI pause
        sql`(${churnedSubscribers.aiPausedUntil} IS NULL OR ${churnedSubscribers.aiPausedUntil} < now())`,
        lte(churnedSubscribers.lastEngagementAt, engagedNudgeCutoff),
      )
    )
    .limit(20)

  let sent = 0
  let suppressed = 0
  let skipped = 0
  let errors = 0

  for (const sub of eligible) {
    try {
      // Skip if the customer has paused sending
      if (await isCustomerPausedForSubscriber(sub.id)) {
        skipped++
        continue
      }

      // Skip if a changelog-triggered win-back was already sent
      const [existingWinBack] = await db
        .select({ id: emailsSent.id })
        .from(emailsSent)
        .where(
          and(
            eq(emailsSent.subscriberId, sub.id),
            eq(emailsSent.type, 'win_back')
          )
        )
        .limit(1)

      if (existingWinBack) {
        skipped++
        continue
      }

      // Load customer for context
      const [customer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, sub.customerId))
        .limit(1)

      if (!customer) {
        skipped++
        continue
      }

      // Rebuild signals from subscriber row
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
        replyText: sub.replyText,
        billingPortalClicked: !!sub.billingPortalClickedAt,
        cancelledAt: sub.cancelledAt ?? new Date(),
      }

      // Re-classify with fresh context
      const classification = await classifySubscriber(signals, {
        founderName: customer.founderName ?? undefined,
        productName: customer.productName ?? undefined,
        changelog: customer.changelogText ?? undefined,
      })

      // Base update fields — always update classification + mark re-engagement attempted
      const updateFields = {
        tier: classification.tier,
        confidence: String(classification.confidence),
        cancellationReason: classification.cancellationReason,
        cancellationCategory: classification.cancellationCategory,
        triggerKeyword: classification.triggerKeyword,
        triggerNeed: classification.triggerNeed,
        winBackSubject: classification.winBackSubject,
        winBackBody: classification.winBackBody,
        reengagementSentAt: new Date(),
        reengagementCount: 1,
        updatedAt: new Date(),
      }

      // If AI says suppress or no message, mark done but don't send
      if (classification.suppress || !classification.firstMessage) {
        await db
          .update(churnedSubscribers)
          .set(updateFields)
          .where(eq(churnedSubscribers.id, sub.id))

        console.log('Reengagement suppressed for:', sub.email, 'tier:', classification.tier)
        suppressed++
        continue
      }

      // Send the re-engagement email
      const fromName = customer.founderName ?? 'The team'
      const { messageId } = await sendEmail({
        to: sub.email!,
        subject: classification.firstMessage.subject,
        body: classification.firstMessage.body,
        fromName,
        subscriberId: sub.id,
      })

      // Record the email
      if (messageId) {
        await db.insert(emailsSent).values({
          subscriberId: sub.id,
          gmailMessageId: messageId,
          type: 'reengagement',
          subject: classification.firstMessage.subject,
        })
      }

      // Update subscriber with re-classification + mark as contacted
      await db
        .update(churnedSubscribers)
        .set({ ...updateFields, status: 'contacted' })
        .where(eq(churnedSubscribers.id, sub.id))

      logEvent({
        name: 'email_sent',
        customerId: sub.customerId,
        properties: {
          subscriberId: sub.id,
          emailType: 'reengagement',
          subject: classification.firstMessage.subject,
          messageId: messageId ?? '',
        },
      })

      console.log('Reengagement email sent to:', sub.email)
      sent++
    } catch (err) {
      console.error('Reengagement error for subscriber:', sub.id, err)
      errors++
    }
  }

  // Spec 21a — process engaged-but-silent nudges (separate cohort from above).
  // Re-uses sendReplyEmail to thread the nudge into the existing conversation
  // and count it against MAX_FOLLOWUPS so we don't badger.
  let nudgeSent = 0
  let nudgeSkipped = 0
  let nudgeErrors = 0

  for (const sub of engagedNudgeCandidates) {
    try {
      if (await isCustomerPausedForSubscriber(sub.id)) {
        nudgeSkipped++
        continue
      }

      // Check we have room within MAX_FOLLOWUPS — otherwise this nudge would
      // trip the handoff inside sendReplyEmail anyway.
      const [followupCount] = await db
        .select({ total: sql<number>`COUNT(*)::int` })
        .from(emailsSent)
        .where(
          and(
            eq(emailsSent.subscriberId, sub.id),
            eq(emailsSent.type, 'followup'),
          )
        )
      if ((followupCount?.total ?? 0) >= 1) {
        // Already at or near limit — let normal flow handle it. Skip nudge.
        nudgeSkipped++
        continue
      }

      const [customer] = await db
        .select()
        .from(customers)
        .where(eq(customers.id, sub.customerId))
        .limit(1)
      if (!customer) {
        nudgeSkipped++
        continue
      }

      // Re-classify with current state to get a fresh nudge message
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
        replyText: sub.replyText,
        billingPortalClicked: !!sub.billingPortalClickedAt,
        cancelledAt: sub.cancelledAt ?? new Date(),
      }

      const classification = await classifySubscriber(signals, {
        founderName: customer.founderName ?? undefined,
        productName: customer.productName ?? undefined,
        changelog: customer.changelogText ?? undefined,
      })

      if (classification.tier === 4 || !classification.firstMessage) {
        // Mark nudged so we don't keep retrying — but no email
        await db
          .update(churnedSubscribers)
          .set({ proactiveNudgeAt: new Date(), updatedAt: new Date() })
          .where(eq(churnedSubscribers.id, sub.id))
        nudgeSkipped++
        continue
      }

      const { sendReplyEmail } = await import('@/src/winback/lib/email')
      const result = await sendReplyEmail({
        subscriberId: sub.id,
        email: sub.email!,
        classification,
        fromName: customer.founderName ?? 'The team',
      })

      if (result.sent) {
        await db
          .update(churnedSubscribers)
          .set({ proactiveNudgeAt: new Date(), updatedAt: new Date() })
          .where(eq(churnedSubscribers.id, sub.id))

        logEvent({
          name: 'proactive_nudge_sent',
          customerId: sub.customerId,
          properties: {
            subscriberId: sub.id,
            daysSinceEngagement: sub.lastEngagementAt
              ? Math.floor((Date.now() - sub.lastEngagementAt.getTime()) / (1000 * 60 * 60 * 24))
              : null,
          },
        })
        nudgeSent++
      } else {
        // sendReplyEmail logged the reason — count appropriately
        nudgeSkipped++
      }
    } catch (err) {
      console.error('Engaged nudge error for subscriber:', sub.id, err)
      nudgeErrors++
    }
  }

  console.log(
    `Reengagement cron complete:`,
    `90-day backstop — ${eligible.length} eligible, ${sent} sent, ${suppressed} suppressed, ${skipped} skipped, ${errors} errors;`,
    `engaged nudge — ${engagedNudgeCandidates.length} eligible, ${nudgeSent} sent, ${nudgeSkipped} skipped, ${nudgeErrors} errors`,
  )

  return NextResponse.json({
    backstop: { processed: eligible.length, sent, suppressed, skipped, errors },
    engagedNudge: { processed: engagedNudgeCandidates.length, sent: nudgeSent, skipped: nudgeSkipped, errors: nudgeErrors },
  })
}

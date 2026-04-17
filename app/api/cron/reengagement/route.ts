import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { churnedSubscribers, customers, emailsSent } from '@/lib/schema'
import { eq, and, lt, isNotNull, inArray, sql } from 'drizzle-orm'
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

  // Find eligible subscribers: fallback window has elapsed
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
        sql`${churnedSubscribers.cancelledAt} + (${churnedSubscribers.fallbackDays} || ' days')::interval <= now()`
      )
    )
    .limit(50)

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

  console.log(`Reengagement cron complete: ${eligible.length} eligible, ${sent} sent, ${suppressed} suppressed, ${skipped} skipped, ${errors} errors`)

  return NextResponse.json({
    processed: eligible.length,
    sent,
    suppressed,
    skipped,
    errors,
  })
}

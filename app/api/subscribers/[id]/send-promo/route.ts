import { NextResponse } from 'next/server'
import { z } from 'zod'
import { and, desc, eq, gte } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  customers,
  churnedSubscribers,
  emailsSent,
  improvements,
  improvementMatches,
} from '@/lib/schema'
import {
  getApplicablePromotionForSubscriber,
  parsePromotionRows,
} from '@/src/winback/lib/promotion-match'
import {
  generatePromotionEmail,
  sanityCheckPromotionEmail,
} from '@/src/winback/lib/improvement-match'
import { sendEmail, buildFromDisplayName } from '@/src/winback/lib/email'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 80 — POST /api/subscribers/[id]/send-promo
 *
 * Merchant-initiated promo send for one churned subscriber. Used by
 * the drawer "Send promo offer" action (and by the bulk-modal flow,
 * which calls this endpoint once per selected subscriber).
 *
 * Mirrors the matcher's tryPromotionPath end-to-end EXCEPT:
 *   1. Skips the hardcoded tier=1 + Price filters — merchant judgment
 *      is the gate at this layer (they explicitly picked this
 *      subscriber).
 *   2. Re-runs the 4 Stripe gates server-side for the chosen promo
 *      against THIS subscriber's stripePriceId. These are
 *      non-negotiable — if Stripe would reject the discount at
 *      checkout, we surface that as a 409 here.
 *   3. Records the send with source='manual' and the clicking user's
 *      id, so the analytics breakdown ("X manual / Y automatic in
 *      last 30d") on /reasons works.
 *   4. Defaults to skipping if a promo was sent within 30 days —
 *      caller can override with { allowDuplicate: true } after the
 *      modal's "Already received — send anyway?" warning.
 *
 * Reuses generatePromotionEmail + sanityCheckPromotionEmail so the
 * email body is identical to the automatic path's output. Subject
 * and body can be overridden by the caller (drawer flow lets the
 * merchant edit the LLM-drafted text before sending).
 */

const schema = z.object({
  improvementId:   z.string().uuid(),
  subjectOverride: z.string().min(1).max(300).optional(),
  bodyOverride:    z.string().min(1).max(10_000).optional(),
  allowDuplicate:  z.boolean().optional().default(false),
  // dryRun=true runs all validation + draft generation but does NOT
  // send, write emailsSent, write the dedup row, or update the
  // subscriber. Used by the drawer modal to populate the email
  // preview before the merchant clicks send. Returns the same shape
  // as a real send plus `draft: { subject, body }`.
  dryRun:          z.boolean().optional().default(false),
})

type ConflictReason =
  | 'subscriber_not_found'
  | 'subscriber_no_email'
  | 'improvement_not_found'
  | 'improvement_not_promotion'
  | 'improvement_archived'
  | 'gate_failed'
  | 'recently_sent'

function conflict(reason: ConflictReason, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: reason, ...extra }, { status: 409 })
}

const RECENT_SEND_WINDOW_DAYS = 30

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Slug is `id` (matches sibling routes under app/api/subscribers/[id]/*);
  // Next.js requires consistent slug names within a dynamic-path tree.
  const { id: subscriberId } = await params

  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', details: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const { improvementId, subjectOverride, bodyOverride, allowDuplicate, dryRun } = parsed.data

  // Resolve customer + ownership in one query — must own the subscriber.
  const [cust] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!cust) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const [sub] = await db
    .select()
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.id, subscriberId),
      eq(churnedSubscribers.customerId, cust.id),
    ))
    .limit(1)
  if (!sub) return conflict('subscriber_not_found')
  if (!sub.email) return conflict('subscriber_no_email')

  // Resolve the improvement + validate it's a published promotion row.
  const [imp] = await db
    .select({
      id:                improvements.id,
      kind:              improvements.kind,
      status:            improvements.status,
      promotionMetadata: improvements.promotionMetadata,
      createdAt:         improvements.createdAt,
      customerId:        improvements.customerId,
    })
    .from(improvements)
    .where(eq(improvements.id, improvementId))
    .limit(1)
  if (!imp || imp.customerId !== cust.id) return conflict('improvement_not_found')
  if (imp.kind !== 'promotion') return conflict('improvement_not_promotion')
  if (imp.status === 'archived') return conflict('improvement_archived')

  // Re-validate the 4 Stripe gates for THIS subscriber's price.
  // promotionsEnabled is passed as true because the merchant explicitly
  // initiated this send — we don't gate manual sends on the toggle.
  const promoRow = parsePromotionRows([{
    id:                imp.id,
    promotionMetadata: imp.promotionMetadata,
    createdAt:         imp.createdAt instanceof Date ? imp.createdAt : new Date(imp.createdAt as unknown as string),
  }])[0]
  if (!promoRow) return conflict('improvement_not_promotion')

  // For manual sends we skip the tier/category subscriber-side filters
  // (merchant judgment overrides) but still enforce all 4 Stripe gates.
  // Pass synthetic tier/category that satisfy the function's signature.
  const gateCheck = getApplicablePromotionForSubscriber(
    {
      tier:                 1,
      cancellationCategory: 'Price',
      mrrCents:             sub.mrrCents,
      stripePriceId:        sub.stripePriceId,
    },
    promoRow,
    true,
  )
  if (!gateCheck) {
    return conflict('gate_failed', {
      detail: 'Stripe would reject this promo at checkout for this subscriber. Pick a different promo or fix the gate in Stripe.',
    })
  }

  // Anti-fatigue: was a re-engagement email sent recently? Caller can
  // override after the modal's warning.
  if (!allowDuplicate) {
    const cutoff = new Date(Date.now() - RECENT_SEND_WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const [recent] = await db
      .select({ id: emailsSent.id, sentAt: emailsSent.sentAt, improvementId: emailsSent.improvementId })
      .from(emailsSent)
      .where(and(
        eq(emailsSent.subscriberId, sub.id),
        eq(emailsSent.type, 'reengagement'),
        gte(emailsSent.sentAt, cutoff),
      ))
      .orderBy(desc(emailsSent.sentAt))
      .limit(1)
    if (recent) {
      return conflict('recently_sent', {
        sentAt:        recent.sentAt?.toISOString(),
        improvementId: recent.improvementId,
      })
    }
  }

  // Build the email body. Use overrides if provided (drawer flow); fall
  // back to LLM-generated otherwise (matches auto path verbatim).
  const fromName = buildFromDisplayName({ founderName: cust.founderName, productName: cust.productName })
  let subject: string
  let body: string
  if (subjectOverride && bodyOverride) {
    subject = subjectOverride
    body    = bodyOverride
  } else {
    const draft = await generatePromotionEmail({
      promotion:      promoRow.promotionMetadata,
      triggerNeed:    sub.triggerNeed,
      subscriberName: sub.name,
      founderName:    fromName,
    })
    if (!draft) {
      return NextResponse.json(
        { error: 'email_generation_failed' },
        { status: 500 },
      )
    }
    const sanity = await sanityCheckPromotionEmail({
      promotion:   promoRow.promotionMetadata,
      triggerNeed: sub.triggerNeed,
      email:       draft,
    })
    if (!sanity.pass) {
      await logEvent({
        name:       'manual_promo_sanity_failed',
        customerId: cust.id,
        properties: {
          subscriberId:  sub.id,
          improvementId: promoRow.id,
          promotionCode: promoRow.promotionMetadata.code,
          sanityReason:  sanity.reason,
        },
      })
      return NextResponse.json(
        { error: 'sanity_failed', detail: sanity.reason },
        { status: 500 },
      )
    }
    subject = subjectOverride ?? draft.subject
    body    = bodyOverride    ?? draft.body
  }

  // dryRun short-circuit — return the draft + the eligibility result
  // without sending. The drawer modal uses this to populate the email
  // preview before the merchant clicks "Send promo offer".
  if (dryRun) {
    return NextResponse.json({
      ok:            true,
      dryRun:        true,
      improvementId: promoRow.id,
      promotionCode: promoRow.promotionMetadata.code,
      draft:         { subject, body },
    })
  }

  // Send via Resend.
  const { messageId } = await sendEmail({
    to:           sub.email,
    subject,
    body,
    fromName,
    subscriberId: sub.id,
  })

  // Record the send in wb_emails_sent with source='manual' so analytics
  // can distinguish merchant-clicked sends from matcher-fired ones.
  if (messageId) {
    await db.insert(emailsSent).values({
      subscriberId:   sub.id,
      gmailMessageId: messageId,
      type:           'reengagement',
      subject,
      improvementId:  promoRow.id,
      source:         'manual',
      sentByUserId:   session.user.id,
    })
  }

  // Dedup ledger row. onConflictDoNothing is fine — re-sends with
  // allowDuplicate just leave the original dedup row in place.
  await db
    .insert(improvementMatches)
    .values({ improvementId: promoRow.id, subscriberId: sub.id, emailedAt: new Date() })
    .onConflictDoNothing()

  await db
    .update(churnedSubscribers)
    .set({ lastReengagedAt: new Date(), status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, sub.id))

  await logEvent({
    name:       'reengagement_email_sent',
    customerId: cust.id,
    properties: {
      subscriberId:   sub.id,
      improvementId:  promoRow.id,
      kind:           'promotion',
      source:         'manual',
      sentByUserId:   session.user.id,
      promotionCode:  promoRow.promotionMetadata.code,
      subject,
    },
  })

  return NextResponse.json({
    ok:            true,
    messageId,
    improvementId: promoRow.id,
    promotionCode: promoRow.promotionMetadata.code,
  })
}

import { redirect } from 'next/navigation'
import { auth, userIsAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, recoveries, churnedSubscribers, wbEvents, improvements } from '@/lib/schema'
import { eq, and, ne, or, isNull, inArray, sql, desc } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
import { ImpersonationBanner } from '@/components/impersonation-banner'
import { BillingPausedBanner } from '@/components/billing-paused-banner'
import { DashboardClient } from './dashboard-client'
import { getSubscriptionDetails } from '@/src/winback/lib/subscription'
import { tierLabel as tierLabelFor, type TierKey } from '@/src/winback/lib/tiers'
import { tierConfig } from '@/src/winback/lib/billing-config'

// Stripe statuses that mean "a renewal has actually failed — surface
// the red banner." past_due is intentionally NOT here: Stripe is still
// mid-retry, the merchant doesn't need to act yet. Mirrors the set in
// billing-enforcement.ts (used by the bulk send/classifier gate).
const UNHEALTHY_SUB_STATUSES = new Set<string>([
  'incomplete_expired',
  'canceled',
  'unpaid',
  'paused',
])
import { WbPromotionMetadataSchema, formatPromotionTerms } from '@/src/winback/lib/promotions'

const DUNNING_REASON = 'Payment failed'

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const isAdmin = await userIsAdmin(session.user.id)

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  // Route protection: redirect to onboarding if Stripe not connected
  if (!customer?.stripeAccessToken) redirect('/onboarding/stripe')

  // 2026-05-30 — the red "billing paused" banner is driven PURELY by the
  // live Stripe subscription status — the single source of truth. We read
  // it fresh on each dashboard render (one Stripe call on a human-paced
  // page is cheap) rather than via the cached isCustomerBillingHealthy,
  // which could serve a stale value from the wrong module instance and
  // leave a just-subscribed merchant staring at "update card." Card
  // presence is NOT inferred here — a card problem only matters once a
  // renewal actually fails, which Stripe surfaces as a status transition.
  // The cached health check still gates the bulk classifier/email paths
  // (see billing-enforcement.ts) where the Stripe-call savings matter.
  const subDetails = customer.stripeSubscriptionId
    ? await getSubscriptionDetails(customer.id)
    : null
  const subUnhealthy =
    !!subDetails && UNHEALTHY_SUB_STATUSES.has(subDetails.status ?? '')

  // First-recovery banner — only show before billing is active. The
  // banner's job is to drive the "add a card" action; once the platform
  // subscription exists, the prompt is wrong (and the customer has already
  // added a card). Phase B uses `stripeSubscriptionId` as the activation
  // signal (the Phase A `plan === 'trial'` field is legacy and stale).
  const billingActive = !!customer?.stripeSubscriptionId
  let firstRecovery: { name: string | null; mrrCents: number } | null = null
  // Spec 51 + spec 53 — ROI/at-risk framing data for the banner.
  // Spec 53 extends the at-risk math to BOTH cohorts (cancellations +
  // failed payments) so the banner reflects what's actually paused.
  let atRiskCount = 0
  let atRiskMrrAnnualizedCents = 0
  let atRiskCancellationsCount = 0
  let atRiskPaymentRecoveriesCount = 0
  // 2026-05-29 — variant B banner: a 3-row preview of "who's next in
  // line" so the abstract "17 more in your queue" becomes concrete.
  // Only populated when !billingActive (the banner is the only consumer).
  type QueuePreviewRow = {
    name: string | null
    mrrCents: number
    cohort: 'win_back' | 'payment_recovery'
    reasonShort: string | null
    badgeLabel: string
  }
  let queuePreview: QueuePreviewRow[] = []
  if (customer && !billingActive) {
    // Spec 51 — join recoveries with churned_subscribers so we can show
    // the recovered subscriber's name, not just a generic "first recovery".
    const recs = await db
      .select({
        name: churnedSubscribers.name,
        mrrCents: recoveries.planMrrCents,
      })
      .from(recoveries)
      .innerJoin(churnedSubscribers, eq(recoveries.subscriberId, churnedSubscribers.id))
      .where(eq(recoveries.customerId, customer.id))
      .limit(1)

    if (recs.length > 0) {
      firstRecovery = { name: recs[0].name, mrrCents: recs[0].mrrCents }
    }

    // Spec 53 — At-risk math split by cohort, summed for the banner total.
    //
    // Cancellations cohort: high/medium-likelihood, not yet recovered,
    //   cancellation_reason is NOT 'Payment failed' (i.e., voluntary cancel
    //   or no reason captured yet).
    // Payment-recovery cohort: cancellation_reason = 'Payment failed' AND
    //   dunning_state IN ('awaiting_retry','final_retry_pending') — the
    //   in-flight dunning states that map to the new "Trial ended" row badge.
    const [cancRow] = await db
      .select({
        count: sql<number>`COUNT(*)::int`,
        mrrSum: sql<number>`COALESCE(SUM(${churnedSubscribers.mrrCents}), 0)::bigint`,
      })
      .from(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.customerId, customer.id),
          or(
            ne(churnedSubscribers.cancellationReason, DUNNING_REASON),
            isNull(churnedSubscribers.cancellationReason),
          ),
          inArray(churnedSubscribers.recoveryLikelihood, ['high', 'medium']),
          ne(churnedSubscribers.status, 'recovered'),
        ),
      )
    const [pmtRow] = await db
      .select({
        count: sql<number>`COUNT(*)::int`,
        mrrSum: sql<number>`COALESCE(SUM(${churnedSubscribers.mrrCents}), 0)::bigint`,
      })
      .from(churnedSubscribers)
      .where(
        and(
          eq(churnedSubscribers.customerId, customer.id),
          eq(churnedSubscribers.cancellationReason, DUNNING_REASON),
          inArray(churnedSubscribers.dunningState, ['awaiting_retry', 'final_retry_pending']),
        ),
      )
    atRiskCancellationsCount = cancRow?.count ?? 0
    atRiskPaymentRecoveriesCount = pmtRow?.count ?? 0
    atRiskCount = atRiskCancellationsCount + atRiskPaymentRecoveriesCount
    const totalMrrCents = Number(cancRow?.mrrSum ?? 0) + Number(pmtRow?.mrrSum ?? 0)
    atRiskMrrAnnualizedCents = totalMrrCents * 12

    // 2026-05-29 — "who's next in line" preview for the variant-B banner.
    // Surfaces 3 actionable rows so the merchant sees real names + MRR
    // sitting behind the paywall, not just an abstract count. Mirrors the
    // same filter conditions used in the at-risk math above (UNION of
    // win-back high/medium + payment-recovery in-flight), ordered by
    // most-recent so the rows feel current, then capped at 3.
    if (atRiskCount > 0) {
      const previewRows = await db
        .select({
          name:                churnedSubscribers.name,
          mrrCents:            churnedSubscribers.mrrCents,
          cancellationReason:  churnedSubscribers.cancellationReason,
          dunningState:        churnedSubscribers.dunningState,
          recoveryLikelihood:  churnedSubscribers.recoveryLikelihood,
          cancelledAt:         churnedSubscribers.cancelledAt,
          createdAt:           churnedSubscribers.createdAt,
        })
        .from(churnedSubscribers)
        .where(and(
          eq(churnedSubscribers.customerId, customer.id),
          or(
            // Win-back cohort: high/medium-likelihood, still open.
            and(
              or(
                ne(churnedSubscribers.cancellationReason, DUNNING_REASON),
                isNull(churnedSubscribers.cancellationReason),
              ),
              inArray(churnedSubscribers.recoveryLikelihood, ['high', 'medium']),
              ne(churnedSubscribers.status, 'recovered'),
            ),
            // Payment-recovery cohort: actively in dunning.
            and(
              eq(churnedSubscribers.cancellationReason, DUNNING_REASON),
              inArray(churnedSubscribers.dunningState, ['awaiting_retry', 'final_retry_pending']),
            ),
          )!,
        ))
        // Most recent first — across cohorts createdAt is the always-set
        // timestamp (payment-recovery rows lack cancelledAt). Coalescing
        // via COALESCE keeps the ordering meaningful for both.
        .orderBy(sql`COALESCE(${churnedSubscribers.cancelledAt}, ${churnedSubscribers.createdAt}) DESC`)
        .limit(3)

      queuePreview = previewRows.map((r): QueuePreviewRow => {
        const isPayment = r.cancellationReason === DUNNING_REASON
        const badgeLabel = isPayment
          ? r.dunningState === 'final_retry_pending' ? 'Final retry' : 'Awaiting retry'
          : r.recoveryLikelihood === 'high' ? 'High recovery' : 'Awaiting reply'
        // Truncate the reason for the row — full text shows in the table.
        const reasonShort = isPayment
          ? 'Payment failed'
          : r.cancellationReason
            ? r.cancellationReason.length > 60
              ? r.cancellationReason.slice(0, 57) + '…'
              : r.cancellationReason
            : 'Cancelled'
        return {
          name:        r.name,
          mrrCents:    r.mrrCents,
          cohort:      isPayment ? 'payment_recovery' : 'win_back',
          reasonShort,
          badgeLabel,
        }
      })
    }
  }

  // Has this customer ever had a platform subscription that was later
  // canceled? Used to distinguish:
  //   - "Your trial ended on your first recovery."   (first-time paused)
  //   - "Your subscription ended."                   (re-paused after cancel)
  // Single cheap event lookup; we don't need the row data, just existence.
  // Spec — see follow-up to spec 53/54.
  let everSubscribed = false
  if (customer && !billingActive) {
    const cancelEvents = await db
      .select({ id: wbEvents.id })
      .from(wbEvents)
      .where(and(
        eq(wbEvents.customerId, customer.id),
        eq(wbEvents.name, 'platform_subscription_canceled'),
      ))
      .limit(1)
    everSubscribed = cancelEvents.length > 0
  }

  // Spec 31 — pilot status. If pilot_until is in the future, the dashboard
  // shows a "🚀 Pilot — until {date}" banner instead of the "your $99/mo
  // subscription will start when…" prompt (which would be wrong copy for
  // pilots). The bypass gates in activation + perf-fee already make sure
  // no charges fire while pilot_until > now.
  const pilotUntil =
    customer?.pilotUntil && customer.pilotUntil.getTime() > Date.now()
      ? customer.pilotUntil
      : null

  // Spec 80 — load the merchant's published promotions so the drawer
  // "Send promo offer" modal can render the dropdown. Parsing the
  // jsonb metadata here (server-side) keeps the client component pure
  // and avoids shipping the full schema parser to the browser.
  const promoRows = await db
    .select({
      id:                improvements.id,
      promotionMetadata: improvements.promotionMetadata,
    })
    .from(improvements)
    .where(and(
      eq(improvements.customerId, customer.id),
      eq(improvements.kind, 'promotion'),
      eq(improvements.status, 'published'),
    ))
    .orderBy(desc(improvements.createdAt))

  const promoOptions = promoRows.flatMap((r) => {
    const parsed = WbPromotionMetadataSchema.safeParse(r.promotionMetadata)
    if (!parsed.success) return []
    const m = parsed.data
    return [{
      id:                r.id,
      code:              m.code,
      terms:             formatPromotionTerms(m),
      active:            m.active,
      redeemBy:          m.redeemBy,
      maxRedemptions:    m.maxRedemptions,
      timesRedeemed:     m.timesRedeemed,
      appliesToPriceIds: m.appliesToPriceIds,
    }]
  })

  // 2026-05-30 — red banner shows iff the live Stripe sub is in a
  // failed-renewal state. No sub on file → never shows (the never-paid /
  // first-save case is handled by the green FirstRecoveryBanner inside
  // DashboardClient; subUnhealthy is false there because there's no sub
  // to be unhealthy). This single source-of-truth check replaces the old
  // billingHealthy && !firstSaveAwaitingCard combination.
  return (
    <>
      <ImpersonationBanner />
      {subUnhealthy && (
        <BillingPausedBanner
          tierLabel={
            customer.billedTier &&
            customer.billedTier !== 'custom' &&
            customer.billedTier !== 'enterprise'
              ? tierLabelFor(customer.billedTier as TierKey)
              : undefined
          }
        />
      )}
      <TopNav userName={session.user.name} isAdmin={isAdmin} />
      <main className="min-h-screen bg-[#f5f5f5]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <DashboardClient
            isTrial={!billingActive}
            firstRecovery={firstRecovery}
            pilotUntilIso={pilotUntil ? pilotUntil.toISOString() : null}
            founderName={customer?.founderName ?? session.user.name ?? null}
            atRiskCount={atRiskCount}
            atRiskMrrAnnualizedCents={atRiskMrrAnnualizedCents}
            atRiskCancellationsCount={atRiskCancellationsCount}
            atRiskPaymentRecoveriesCount={atRiskPaymentRecoveriesCount}
            activatedAtIso={customer?.activatedAt ? customer.activatedAt.toISOString() : null}
            everSubscribed={everSubscribed}
            manuallyPausedWinbackAtIso={customer?.pausedAt ? customer.pausedAt.toISOString() : null}
            manuallyPausedDunningAtIso={customer?.pausedDunningAt ? customer.pausedDunningAt.toISOString() : null}
            promoOptions={promoOptions}
            promotionsEnabled={!!customer?.promotionsEnabled}
            queuePreview={queuePreview}
            recommendedTierPriceCents={
              // For the variant-B banner's right rail. Fall back to the
              // Starter price when no recommendation has been computed
              // yet (pre-activation merchants will never see the banner,
              // but the prop has to be non-null for the type).
              customer?.recommendedTier && customer.recommendedTier !== 'enterprise' && customer.recommendedTier !== 'custom'
                ? tierConfig(customer.recommendedTier as TierKey).priceUsdMinor ?? 99_00
                : 99_00
            }
            recommendedTierLabel={
              customer?.recommendedTier && customer.recommendedTier !== 'custom' && customer.recommendedTier !== 'enterprise'
                ? tierLabelFor(customer.recommendedTier as TierKey)
                : 'Starter'
            }
          />
        </div>
      </main>
    </>
  )
}

import { redirect } from 'next/navigation'
import { auth, userIsAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, recoveries, churnedSubscribers, wbEvents } from '@/lib/schema'
import { eq, and, ne, or, isNull, inArray, sql } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
import { ImpersonationBanner } from '@/components/impersonation-banner'
import { BillingPausedBanner } from '@/components/billing-paused-banner'
import { DashboardClient } from './dashboard-client'
import { isCustomerBillingHealthy } from '@/src/winback/lib/billing-enforcement'

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

  // 2026-05-18 — show a service-paused banner when the platform sub
  // is in a non-paying state. Behind the scenes the classifier and
  // email-send paths skip work for this customer (see
  // src/winback/lib/billing-enforcement.ts); the banner is what the
  // merchant actually sees so they know WHY nothing is happening.
  const billingHealthy = await isCustomerBillingHealthy(customer.id)

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

  return (
    <>
      <ImpersonationBanner />
      {!billingHealthy && <BillingPausedBanner />}
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
          />
        </div>
      </main>
    </>
  )
}

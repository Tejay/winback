import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, recoveries, churnedSubscribers } from '@/lib/schema'
import { and, eq, inArray, isNull, ne, or, sql, desc } from 'drizzle-orm'
import { Logo } from '@/components/logo'
import { prepareActivation } from '@/src/winback/lib/activation'
import { TierTransparencyBlock } from '@/components/tier-transparency-block'
import { ActivateButton } from './activate-button'

/**
 * /billing/activate — first-activation confirmation page.
 *
 * 2026-05-29 — redesigned to match the post-pause-at-first-save policy.
 * The page is now SINGLE-SAVE FRAMED, not cumulative-value framed:
 *   - Lead with the one proven recovery (name + MRR) — same proof shown
 *     in the dashboard banner. Consistent story, no "$967 recovered"
 *     surprise that contradicts a "first save" celebration.
 *   - Show the merchant's plan (MRR-derived tier + monthly fee), with
 *     the MRR breakdown for transparency. Recovery-block / ROI rows are
 *     OFF — those frame an ongoing relationship and belong on /settings.
 *   - Show the queue cost (N subscribers paused · $X/yr at risk) — what
 *     they unlock by subscribing.
 *
 * The customer's click on "Subscribe at $X/mo" is the FIRST and ONLY
 * point at which billing is committed. No webhook fire-and-forget, no
 * auto-subscription on card-add.
 *
 * Branches:
 *   - awaiting_confirmation → render first-save proof + plan + queue
 *   - enterprise_handoff    → render contact-sales state, no Subscribe
 *   - pilot                 → render pilot state with end date
 *   - no_op                 → redirect to dashboard (no delivery yet)
 */

const DUNNING_REASON = 'Payment failed'
export default async function BillingActivatePage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) redirect('/onboarding')

  const prep = await prepareActivation(customer.id)
  if (prep.state === 'no_op') redirect('/dashboard')

  // 2026-05-29 — single-save framing data.
  //   - firstRecovery: the single proven recovery to celebrate. Mirrors
  //     the dashboard banner's `firstRecovery` query so both screens
  //     tell the same story.
  //   - queueStats: count + annualized at-risk MRR for "what you unlock
  //     by subscribing." Same shape as dashboard's at-risk math.
  // Lifetime-recovered / 30d-recovered / ROI are deliberately NOT
  // computed here — those frame an ongoing relationship and belong on
  // /settings. See module header for the rationale.
  const [firstRecoveryRow] = await db
    .select({
      name:     churnedSubscribers.name,
      mrrCents: recoveries.planMrrCents,
    })
    .from(recoveries)
    .innerJoin(churnedSubscribers, eq(recoveries.subscriberId, churnedSubscribers.id))
    .where(and(
      eq(recoveries.customerId, customer.id),
      inArray(recoveries.attributionType, ['strong', 'weak']),
    ))
    .orderBy(desc(recoveries.recoveredAt))
    .limit(1)

  const [cancStats] = await db
    .select({
      count:  sql<number>`COUNT(*)::int`,
      mrrSum: sql<number>`COALESCE(SUM(${churnedSubscribers.mrrCents}), 0)::bigint`,
    })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customer.id),
      or(
        ne(churnedSubscribers.cancellationReason, DUNNING_REASON),
        isNull(churnedSubscribers.cancellationReason),
      ),
      inArray(churnedSubscribers.recoveryLikelihood, ['high', 'medium']),
      ne(churnedSubscribers.status, 'recovered'),
    ))
  const [pmtStats] = await db
    .select({
      count:  sql<number>`COUNT(*)::int`,
      mrrSum: sql<number>`COALESCE(SUM(${churnedSubscribers.mrrCents}), 0)::bigint`,
    })
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customer.id),
      eq(churnedSubscribers.cancellationReason, DUNNING_REASON),
      inArray(churnedSubscribers.dunningState, ['awaiting_retry', 'final_retry_pending']),
    ))
  const queueCount = (cancStats?.count ?? 0) + (pmtStats?.count ?? 0)
  const queueMrrCentsMonthly = Number(cancStats?.mrrSum ?? 0) + Number(pmtStats?.mrrSum ?? 0)
  const queueMrrCentsAnnualized = queueMrrCentsMonthly * 12

  return (
    <div className="min-h-screen bg-[#f5f5f5]">
      <div className="mx-auto mb-8 mt-12 flex justify-center">
        <Logo />
      </div>

      <div className="mx-auto max-w-xl space-y-6 px-4">
        {prep.state === 'pilot' && (
          <Card>
            <h1 className="mb-2 text-xl font-semibold text-slate-900">
              You&apos;re on a pilot
            </h1>
            <p className="text-sm text-slate-600">
              WinbackFlow is running for free until{' '}
              {prep.pilotUntil
                ? new Date(prep.pilotUntil).toLocaleDateString(undefined, {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })
                : 'pilot end'}
              . After that we&apos;ll prompt you to subscribe at the tier that matches
              your then-current MRR.
            </p>
            <TierTransparencyBlockShell
              showRecoveryBlock={false}
              data={{
                tier: null,
                priceUsdMinor: null,
                mrrUsdMinor: 0,
                trailing30dRecoveredUsdMinor: 0,
              }}
            />
          </Card>
        )}

        {prep.state === 'enterprise_handoff' && (
          <Card>
            <h1 className="mb-2 text-xl font-semibold text-slate-900">
              Let&apos;s talk
            </h1>
            <p className="mb-4 text-sm text-slate-600">
              Your computed MRR puts you in the Enterprise tier. We don&apos;t
              auto-subscribe Enterprise accounts — pricing is bespoke. Our
              sales team will reach out shortly; in the meantime, WinbackFlow
              continues to run recoveries on your account.
            </p>
            <a
              href="mailto:sales@winbackflow.co?subject=Enterprise%20activation"
              className="inline-flex items-center justify-center rounded-full bg-[#0f172a] px-5 py-2 text-sm font-medium text-white hover:bg-[#1e293b]"
            >
              Contact sales
            </a>
            <TierTransparencyBlockShell
              showRecoveryBlock={false}
              data={{
                tier: 'enterprise',
                priceUsdMinor: null,
                mrrUsdMinor: prep.mrrUsdMinor,
                trailing30dRecoveredUsdMinor: 0,
                breakdown: prep.mrrBreakdown,
              }}
            />
          </Card>
        )}

        {prep.state === 'awaiting_confirmation' && (
          <>
            {/* Hero — celebrate the single proven save. Same story as
                the dashboard banner so the two screens cohere. */}
            <Card>
              <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-emerald-600">
                Proof of value
              </p>
              <h1 className="mb-3 text-2xl font-bold text-slate-900">
                Activate WinbackFlow
              </h1>
              {firstRecoveryRow ? (
                <div className="inline-flex flex-wrap items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50/60 px-3 py-1.5 text-sm">
                  <span className="rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-xs font-semibold text-emerald-700">
                    ✓ Recovered
                  </span>
                  <span className="font-medium text-slate-900">
                    {firstRecoveryRow.name ?? 'Your first subscriber'}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="font-semibold text-emerald-700">
                    ${((firstRecoveryRow.mrrCents ?? 0) / 100).toFixed(0)}/mo restored
                  </span>
                </div>
              ) : (
                <p className="text-sm text-slate-600">
                  We&apos;ve delivered your first recovery.
                </p>
              )}
              <p className="mt-4 text-sm text-slate-600">
                That&apos;s the proof. Subscribe to keep WinbackFlow running on the rest of your queue.
              </p>
            </Card>

            {/* Plan + MRR breakdown — what they're consenting to.
                showRecoveryBlock={false} suppresses the "Recovered (30d)
                + ROI" rows; those frame an ongoing relationship and
                only make sense post-subscription on /settings. */}
            <Card>
              <h2 className="mb-3 text-base font-semibold text-slate-900">
                Your plan
              </h2>
              <TierTransparencyBlock
                showRecoveryBlock={false}
                data={{
                  tier: prep.tier,
                  priceUsdMinor: prep.priceUsdMinor,
                  mrrUsdMinor: prep.mrrUsdMinor,
                  trailing30dRecoveredUsdMinor: 0,
                  breakdown: prep.mrrBreakdown,
                  perCurrency: prep.perCurrency,
                }}
              />
            </Card>

            {/* Queue cost — what they unlock by subscribing. */}
            {queueCount > 0 && (
              <Card>
                <h2 className="mb-1 text-base font-semibold text-slate-900">
                  Your queue
                </h2>
                <p className="text-sm text-slate-600">
                  <strong className="text-slate-900">
                    {queueCount} {queueCount === 1 ? 'subscriber' : 'subscribers'}
                  </strong>{' '}
                  paused — waiting for sends to resume.
                </p>
                <p className="mt-2 text-sm text-slate-600">
                  <strong className="text-rose-700">
                    ${Math.round(queueMrrCentsAnnualized / 100).toLocaleString()}/yr
                  </strong>{' '}
                  in MRR sitting in the queue. We&apos;ll work them the same
                  way we worked the recovery above.
                </p>
              </Card>
            )}

            <ActivateButton
              confirmedTier={prep.tier}
              priceUsdMinor={prep.priceUsdMinor}
            />

            <p className="text-center text-xs text-slate-500">
              This looks wrong?{' '}
              <a
                href="mailto:sales@winbackflow.co?subject=Tier%20assignment%20question"
                className="underline hover:text-slate-700"
              >
                Tell us
              </a>{' '}
              and we&apos;ll review before any charge.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
      {children}
    </div>
  )
}

// Thin wrapper so the TransparencyBlock card sits inside the parent Card
// with a consistent top-margin without imposing on the standalone uses
// (dashboard, settings).
function TierTransparencyBlockShell(props: React.ComponentProps<typeof TierTransparencyBlock>) {
  return (
    <div className="mt-4">
      <TierTransparencyBlock {...props} />
    </div>
  )
}

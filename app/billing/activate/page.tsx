import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, recoveries } from '@/lib/schema'
import { and, eq, gte, inArray } from 'drizzle-orm'
import { Logo } from '@/components/logo'
import { prepareActivation } from '@/src/winback/lib/activation'
import { ROI_DISPLAY_WINDOW_DAYS } from '@/src/winback/lib/billing-config'
import { TierTransparencyBlock } from '@/components/tier-transparency-block'
import { ActivateButton } from './activate-button'

/**
 * /billing/activate — the dispute-proof activation confirmation page.
 *
 * After the customer's first delivered recovery, they're directed here to
 * confirm and subscribe. We compute their MRR live, derive the
 * recommended tier (bias-low on band edges), and surface everything —
 * MRR figure, breakdown, tier band, monthly fee, trailing-30d recovered
 * — before any charge.
 *
 * The customer's click on "Subscribe at $X/mo" is the FIRST and ONLY
 * point at which billing is committed. No webhook fire-and-forget, no
 * auto-subscription on card-add.
 *
 * Branches:
 *   - awaiting_confirmation → render breakdown + Subscribe button
 *   - enterprise_handoff    → render contact-sales state, no Subscribe
 *   - pilot                 → render pilot state with end date
 *   - no_op                 → redirect to dashboard (no delivery yet)
 */
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

  // Two figures we surface:
  //   - lifetime recovered: drives the activation hero copy ("We recovered
  //     $X for you"). The onramp gate is event-based (first delivered
  //     recovery), NOT a 30-day window — so the hero number must be the
  //     total of what triggered the ask, which is everything we've
  //     recovered for this account.
  //   - trailing-30d recovered: feeds the ROI block (ongoing health
  //     signal). Same as dashboard + settings.
  // Both filter attribution_type IN (strong, weak); organic excluded.
  const recoveryRows = await db
    .select({
      mrrCents: recoveries.planMrrCents,
      recoveredAt: recoveries.recoveredAt,
    })
    .from(recoveries)
    .where(
      and(
        eq(recoveries.customerId, customer.id),
        inArray(recoveries.attributionType, ['strong', 'weak']),
      ),
    )
  const lifetimeRecoveredUsdMinor = recoveryRows.reduce(
    (sum, r) => sum + (r.mrrCents ?? 0),
    0,
  )
  const trailing30dCutoff = new Date(
    Date.now() - ROI_DISPLAY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  )
  const trailing30dRecoveredUsdMinor = recoveryRows
    .filter((r) => r.recoveredAt !== null && r.recoveredAt >= trailing30dCutoff)
    .reduce((sum, r) => sum + (r.mrrCents ?? 0), 0)

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
              data={{
                tier: null,
                priceUsdMinor: null,
                mrrUsdMinor: 0,
                trailing30dRecoveredUsdMinor,
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
              data={{
                tier: 'enterprise',
                priceUsdMinor: null,
                mrrUsdMinor: prep.mrrUsdMinor,
                trailing30dRecoveredUsdMinor,
                breakdown: prep.mrrBreakdown,
              }}
            />
          </Card>
        )}

        {prep.state === 'awaiting_confirmation' && (
          <>
            <Card>
              <h1 className="mb-2 text-xl font-semibold text-slate-900">
                Activate your subscription
              </h1>
              <p className="mb-4 text-sm text-slate-600">
                WinbackFlow has recovered{' '}
                <strong>
                  ${(lifetimeRecoveredUsdMinor / 100).toLocaleString()}
                </strong>{' '}
                for you. Confirm your plan to keep it running.
              </p>
              <TierTransparencyBlockShell
                data={{
                  tier: prep.tier,
                  priceUsdMinor: prep.priceUsdMinor,
                  mrrUsdMinor: prep.mrrUsdMinor,
                  trailing30dRecoveredUsdMinor,
                  breakdown: prep.mrrBreakdown,
                  perCurrency: prep.perCurrency,
                }}
              />
            </Card>

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

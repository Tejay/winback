import Link from 'next/link'
import { redirect } from 'next/navigation'
import Stripe from 'stripe'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries, settlementRequests } from '@/lib/schema'
import { and, eq, sql } from 'drizzle-orm'
import { slugifyWorkspaceName } from '@/src/winback/lib/workspace'
import { computeOpenObligations } from '@/src/winback/lib/obligations'
import { DeleteConfirmation } from './delete-confirmation'
import { SettlementRequired } from './settlement-required'

export const metadata = { title: 'Delete workspace — Winback' }

interface PageProps {
  searchParams?: Promise<{ settlement?: string; session_id?: string }>
}

export default async function DeleteWorkspacePage({ searchParams }: PageProps) {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const sp = (await searchParams) ?? {}
  let settlementJustPaid = false

  const [customer] = await db
    .select({
      id: customers.id,
      productName: customers.productName,
      stripeAccessToken: customers.stripeAccessToken,
      gmailRefreshToken: customers.gmailRefreshToken,
      pausedAt: customers.pausedAt,
    })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  const email = session.user.email ?? ''
  const workspaceName = slugifyWorkspaceName(customer?.productName, email)

  let subscribersCount = 0
  let recoveriesCount = 0
  let recoveredCents = 0
  let obligations = {
    openObligationCents: 0,
    liveCount: 0,
    earliestEndsAt: null as Date | null,
    latestEndsAt: null as Date | null,
  }
  let alreadyRequestedAt: Date | null = null

  if (customer) {
    // Stripe Checkout success return. Verify the session server-side before
    // trusting the success query param, then stamp settlement_paid_at so
    // computeOpenObligations() returns 0 and Gates 1-3 unlock.
    if (sp.settlement === 'success' && sp.session_id) {
      const secretKey = process.env.STRIPE_SECRET_KEY
      if (secretKey) {
        try {
          const stripe = new Stripe(secretKey)
          const s = await stripe.checkout.sessions.retrieve(sp.session_id)
          if (
            s.payment_status === 'paid' &&
            s.metadata?.type === 'winback_settlement' &&
            s.metadata?.customerId === customer.id
          ) {
            await db
              .update(customers)
              .set({ settlementPaidAt: new Date() })
              .where(eq(customers.id, customer.id))
            await db
              .update(settlementRequests)
              .set({ status: 'settled', settledAt: new Date() })
              .where(
                and(
                  eq(settlementRequests.customerId, customer.id),
                  eq(settlementRequests.stripeSessionId, sp.session_id),
                ),
              )
            settlementJustPaid = true
          }
        } catch {
          // If verification fails we just fall through — the user will still
          // see the settlement gate and can retry.
        }
      }
    }

    obligations = await computeOpenObligations(customer.id)

    if (obligations.openObligationCents > 0) {
      const [existing] = await db
        .select({ requestedAt: settlementRequests.requestedAt })
        .from(settlementRequests)
        .where(
          and(
            eq(settlementRequests.customerId, customer.id),
            eq(settlementRequests.status, 'pending'),
          ),
        )
        .limit(1)
      alreadyRequestedAt = existing?.requestedAt ?? null
    }
    const [subRow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(churnedSubscribers)
      .where(eq(churnedSubscribers.customerId, customer.id))
    subscribersCount = subRow?.n ?? 0

    const [recRow] = await db
      .select({
        n: sql<number>`count(*)::int`,
        sum: sql<number>`coalesce(sum(${recoveries.planMrrCents}), 0)::int`,
      })
      .from(recoveries)
      .where(eq(recoveries.customerId, customer.id))
    recoveriesCount = recRow?.n ?? 0
    recoveredCents = recRow?.sum ?? 0
  }

  const pounds = (cents: number) =>
    `£${(cents / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`

  return (
    <main className="min-h-screen bg-[#f5f5f5] py-12 px-6">
      <div className="max-w-2xl mx-auto">
        <Link href="/settings" className="text-sm text-slate-500 hover:text-slate-900">
          &larr; Back to Settings
        </Link>

        <div className="mt-6 bg-white border border-rose-200 rounded-2xl shadow-sm p-8">
          <div className="text-xs font-semibold tracking-widest uppercase text-rose-600">
            Danger zone
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mt-2">
            Before you delete your workspace
          </h1>
          <p className="text-sm text-slate-500 mt-2">
            This will permanently:
          </p>

          <ul className="mt-5 space-y-2.5 text-sm text-slate-700">
            {customer?.stripeAccessToken && (
              <li className="flex items-start gap-2.5">
                <span className="text-rose-500 font-bold">&times;</span>
                <span>Disconnect your Stripe account</span>
              </li>
            )}
            {customer?.gmailRefreshToken && (
              <li className="flex items-start gap-2.5">
                <span className="text-rose-500 font-bold">&times;</span>
                <span>Disconnect your Gmail account</span>
              </li>
            )}
            <li className="flex items-start gap-2.5">
              <span className="text-rose-500 font-bold">&times;</span>
              <span>
                Delete{' '}
                <strong className="text-slate-900">{subscribersCount.toLocaleString()}</strong>{' '}
                churned subscriber record{subscribersCount === 1 ? '' : 's'}
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="text-rose-500 font-bold">&times;</span>
              <span>
                Delete{' '}
                <strong className="text-slate-900">{recoveriesCount.toLocaleString()}</strong>{' '}
                recovery record{recoveriesCount === 1 ? '' : 's'} worth{' '}
                <strong className="text-slate-900">{pounds(recoveredCents)}</strong>{' '}
                recovered
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="text-rose-500 font-bold">&times;</span>
              <span>Cancel your billing immediately</span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="text-rose-500 font-bold">&times;</span>
              <span>Remove all email sequences in progress</span>
            </li>
          </ul>

          <p className="mt-6 text-sm text-slate-900 font-medium">
            This cannot be undone. There is no grace period.
          </p>

          {settlementJustPaid && (
            <div className="mt-6 bg-green-50 border border-green-200 rounded-xl p-4 text-sm text-green-900">
              <strong className="font-semibold">Settlement paid.</strong>{' '}
              Your attribution obligations are cleared. You can now delete
              your workspace below.
            </div>
          )}

          {obligations.openObligationCents > 0 ? (
            <SettlementRequired
              openObligationCents={obligations.openObligationCents}
              liveCount={obligations.liveCount}
              earliestEndsAt={obligations.earliestEndsAt?.toISOString() ?? null}
              latestEndsAt={obligations.latestEndsAt?.toISOString() ?? null}
              alreadyRequestedAt={alreadyRequestedAt?.toISOString() ?? null}
            />
          ) : (
            <>
              {!customer?.pausedAt && (
                <div className="mt-6 bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900">
                  <strong className="font-semibold">Not ready to delete?</strong>{' '}
                  You can{' '}
                  <Link href="/settings" className="underline hover:text-amber-950">
                    pause all emails instead
                  </Link>{' '}
                  — your data stays intact and you can reactivate anytime.
                </div>
              )}
              <DeleteConfirmation workspaceName={workspaceName} />
            </>
          )}
        </div>
      </div>
    </main>
  )
}

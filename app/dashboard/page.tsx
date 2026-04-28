import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, recoveries } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
import { DashboardClient } from './dashboard-client'

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  // Route protection: redirect to onboarding if Stripe not connected
  if (!customer?.stripeAccessToken) redirect('/onboarding/stripe')

  // First-recovery banner — only show before billing is active. The
  // banner's job is to drive the "add a card" action; once the platform
  // subscription exists, the prompt is wrong (and the customer has already
  // added a card). Phase B uses `stripeSubscriptionId` as the activation
  // signal (the Phase A `plan === 'trial'` field is legacy and stale).
  const billingActive = !!customer?.stripeSubscriptionId
  let firstRecovery: { name: string | null; mrrCents: number } | null = null
  if (customer && !billingActive) {
    const recs = await db
      .select()
      .from(recoveries)
      .where(eq(recoveries.customerId, customer.id))
      .limit(1)

    if (recs.length > 0) {
      firstRecovery = { name: null, mrrCents: recs[0].planMrrCents }
    }
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
      <TopNav userName={session.user.name} />
      <main className="min-h-screen bg-[#f5f5f5]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
          <DashboardClient
            changelog={customer?.changelogText ?? ''}
            isTrial={!billingActive}
            firstRecovery={firstRecovery}
            pilotUntilIso={pilotUntil ? pilotUntil.toISOString() : null}
          />
        </div>
      </main>
    </>
  )
}

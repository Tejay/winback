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

  // Route protection: redirect to onboarding if not complete
  if (!customer?.stripeAccessToken) redirect('/onboarding/stripe')
  if (!customer?.onboardingComplete) redirect('/onboarding/changelog')

  // Check if billing alert should show
  let firstRecovery: { name: string | null; mrrCents: number } | null = null
  if (customer?.plan === 'trial') {
    const recs = await db
      .select()
      .from(recoveries)
      .where(eq(recoveries.customerId, customer.id))
      .limit(1)

    if (recs.length > 0) {
      // Get the recovered subscriber details from the recovery
      firstRecovery = { name: null, mrrCents: recs[0].planMrrCents }
    }
  }

  return (
    <>
      <TopNav userName={session.user.name} />
      <main className="min-h-screen bg-[#f5f5f5]">
        <div className="max-w-5xl mx-auto px-6 py-8">
          <DashboardClient
            changelog={customer?.changelogText ?? ''}
            isTrial={customer?.plan === 'trial'}
            firstRecovery={firstRecovery}
          />
        </div>
      </main>
    </>
  )
}

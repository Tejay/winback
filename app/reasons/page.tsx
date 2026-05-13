import { redirect } from 'next/navigation'
import { auth, userIsAdmin } from '@/lib/auth'

// Defensive — `dateShipped` is a Postgres DATE (Drizzle returns YYYY-MM-DD
// string), but if anything else creeps in (Date, null, undefined) we still
// produce a valid YYYY-MM-DD string instead of crashing the page render.
function toIsoDate(v: unknown): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  return new Date().toISOString().slice(0, 10)
}

function toIsoDateTime(v: unknown): string {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString()
  if (typeof v === 'string') return v
  return new Date().toISOString()
}

import { db } from '@/lib/db'
import { customers, improvements } from '@/lib/schema'
import { eq, desc } from 'drizzle-orm'
import { TopNav } from '@/components/top-nav'
import { ReasonsClient } from './reasons-client'

/**
 * Spec 65 Phase 2 — Winback Reasons page.
 *
 * Server shell. Auth check, fetch the customer's improvements, hand off
 * to ReasonsClient for interactivity.
 */
export default async function ReasonsPage() {
  const session = await auth()
  if (!session?.user?.id) redirect('/login')

  const isAdmin = await userIsAdmin(session.user.id)

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) redirect('/onboarding/stripe')
  if (!customer.stripeAccessToken) redirect('/onboarding/stripe')

  const rows = await db
    .select()
    .from(improvements)
    .where(eq(improvements.customerId, customer.id))
    .orderBy(desc(improvements.dateShipped))

  return (
    <>
      <TopNav userName={session.user.name} isAdmin={isAdmin} />
      <main className="min-h-screen bg-[#f5f5f5]">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">Winback</p>
          <h1 className="text-4xl font-bold mt-1 text-slate-900">Winback reasons.</h1>
          <p className="text-sm text-slate-500 mt-3 max-w-2xl">
            Real product improvements that go to cancelled customers who
            asked for them. Up to <strong>10 active improvements</strong> at a time.
          </p>

          <div className="mt-8">
            <ReasonsClient initialImprovements={rows.map((r) => ({
              id:               r.id,
              title:            r.title,
              description:      r.description,
              dateShipped:      toIsoDate(r.dateShipped),
              status:           r.status as 'published' | 'archived',
              addressesPattern: r.addressesPattern ?? null,
              preempted:        r.preempted,
              createdAt:        toIsoDateTime(r.createdAt),
            }))} />
          </div>
        </div>
      </main>
    </>
  )
}

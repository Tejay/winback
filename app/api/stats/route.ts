import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { eq, inArray, sql } from 'drizzle-orm'

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const allSubs = await db
    .select({ status: churnedSubscribers.status })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.customerId, customer.id))

  const total = allSubs.length
  const recovered = allSubs.filter((s) => s.status === 'recovered').length
  const pending = allSubs.filter(
    (s) => s.status === 'pending' || s.status === 'contacted'
  ).length
  const recoveryRate = total > 0 ? Math.round((recovered / total) * 100) : 0

  // Phase D — `still_active` column dropped (column was never updated by
  // production code post-Phase B). Counting all recoveries for this
  // customer matches what was actually shown before the drop.
  const activeRecoveries = await db
    .select({ planMrrCents: recoveries.planMrrCents })
    .from(recoveries)
    .where(eq(recoveries.customerId, customer.id))

  const mrrRecoveredCents = activeRecoveries.reduce(
    (sum, r) => sum + r.planMrrCents,
    0
  )

  return NextResponse.json({
    recoveryRate,
    recovered,
    mrrRecoveredCents,
    pending,
  })
}

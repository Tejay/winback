import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, recoveries } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.id, id),
        eq(churnedSubscribers.customerId, customer.id)
      )
    )
    .limit(1)

  if (!subscriber) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  await db.insert(recoveries).values({
    subscriberId: id,
    customerId: customer.id,
    planMrrCents: subscriber.mrrCents,
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'recovered', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, id))

  return NextResponse.json({ success: true })
}

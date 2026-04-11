import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and, or, ilike, desc } from 'drizzle-orm'

export async function GET(req: NextRequest) {
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

  const { searchParams } = req.nextUrl
  const filter = searchParams.get('filter') ?? 'all'
  const search = searchParams.get('search') ?? ''

  const conditions = [eq(churnedSubscribers.customerId, customer.id)]

  if (filter !== 'all') {
    conditions.push(eq(churnedSubscribers.status, filter))
  }

  if (search) {
    const searchPattern = `%${search}%`
    conditions.push(
      or(
        ilike(churnedSubscribers.name, searchPattern),
        ilike(churnedSubscribers.email, searchPattern),
        ilike(churnedSubscribers.cancellationReason, searchPattern)
      )!
    )
  }

  const subs = await db
    .select()
    .from(churnedSubscribers)
    .where(and(...conditions))
    .orderBy(desc(churnedSubscribers.cancelledAt))

  return NextResponse.json(subs)
}

import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'

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

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.STRIPE_CLIENT_ID!,
    scope: 'read_only',
    state: customer.id,
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/stripe/callback`,
  })

  return NextResponse.redirect(
    `https://connect.stripe.com/oauth/authorize?${params.toString()}`
  )
}

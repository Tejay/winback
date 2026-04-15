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

  // NEXT_PUBLIC_APP_URL is used for Stripe redirect_uri because it must be
  // the publicly accessible URL (ngrok in dev, Vercel domain in prod).
  // NEXTAUTH_URL may differ (localhost for browser sessions).
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.STRIPE_CLIENT_ID!,
    // read_write is intentional and narrowly used: the only write operation we
    // perform is renewing/reactivating a cancelled subscription when the
    // customer accepts a one-click win-back offer. Read is used for everything
    // else. See /faq for the customer-facing explanation.
    scope: 'read_write',
    stripe_landing: 'login',
    state: customer.id,
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/stripe/callback`,
  })

  return NextResponse.redirect(
    `https://connect.stripe.com/oauth/authorize?${params.toString()}`
  )
}

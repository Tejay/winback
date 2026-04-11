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
    client_id: process.env.GMAIL_CLIENT_ID!,
    redirect_uri: process.env.GMAIL_REDIRECT_URI!,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify',
    access_type: 'offline',
    prompt: 'consent',
    state: customer.id,
  })

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  )
}

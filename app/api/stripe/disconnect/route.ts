import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'

export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  await db
    .update(customers)
    .set({
      stripeAccountId: null,
      stripeAccessToken: null,
      updatedAt: new Date(),
    })
    .where(eq(customers.userId, session.user.id))

  return NextResponse.json({ success: true })
}

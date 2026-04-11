import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'

export async function PATCH(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()

  const updates: Record<string, unknown> = { updatedAt: new Date() }

  if (body.onboardingComplete !== undefined) {
    updates.onboardingComplete = body.onboardingComplete
  }
  if (body.founderName !== undefined) {
    updates.founderName = body.founderName
  }
  if (body.productName !== undefined) {
    updates.productName = body.productName
  }

  await db
    .update(customers)
    .set(updates)
    .where(eq(customers.userId, session.user.id))

  return NextResponse.json({ success: true })
}

import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'

/**
 * POST /api/settings/pause
 * Body: { paused: boolean }
 *
 * Toggles the customer's paused_at flag. When paused, scheduleExitEmail()
 * will skip sending for every subscriber owned by this customer.
 * Cancellations continue to be recorded — nothing is lost.
 */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body.paused !== 'boolean') {
    return NextResponse.json({ error: 'Expected { paused: boolean }' }, { status: 400 })
  }

  await db
    .update(customers)
    .set({
      pausedAt: body.paused ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(customers.userId, session.user.id))

  return NextResponse.json({ ok: true, paused: body.paused })
}

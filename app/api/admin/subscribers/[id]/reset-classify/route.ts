import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { churnedSubscribers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 72 — admin reset of the classifier dead-letter counter for one row.
 *
 * POST (no body)
 *
 * Sets classify_attempts = 0 on the subscriber so the classifier cron
 * picks them up again on the next tick. Use after fixing whatever caused
 * the dead-letter (prompt bug, schema drift, etc.).
 *
 * Audit-logged so we know who reset what.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const { id } = await params

  const [existing] = await db
    .select({
      id: churnedSubscribers.id,
      customerId: churnedSubscribers.customerId,
      classifyAttempts: churnedSubscribers.classifyAttempts,
    })
    .from(churnedSubscribers)
    .where(eq(churnedSubscribers.id, id))
    .limit(1)

  if (!existing) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  if (existing.classifyAttempts === 0) {
    return NextResponse.json(
      { error: 'classify_attempts is already 0; nothing to reset' },
      { status: 400 },
    )
  }

  await db
    .update(churnedSubscribers)
    .set({ classifyAttempts: 0, updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, id))

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    customerId: existing.customerId,
    properties: {
      action: 'reset_classify_attempts',
      subscriberId: id,
      previousAttempts: existing.classifyAttempts,
    },
  })

  return NextResponse.json({ ok: true, previousAttempts: existing.classifyAttempts })
}

import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, improvements } from '@/lib/schema'
import { and, eq, count } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

const MAX_ACTIVE_IMPROVEMENTS = 10

/**
 * Spec 65 Phase 2 — Restore an archived improvement back to 'published'.
 *
 * POST /api/improvements/[id]/restore
 *
 * Refuses if it would push the merchant past the 10-active cap.
 */

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
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

  const [{ active } = { active: 0 }] = await db
    .select({ active: count() })
    .from(improvements)
    .where(and(eq(improvements.customerId, customer.id), eq(improvements.status, 'published')))

  if (active >= MAX_ACTIVE_IMPROVEMENTS) {
    return NextResponse.json(
      { error: `Already at ${MAX_ACTIVE_IMPROVEMENTS} active improvements. Archive another before restoring this one.` },
      { status: 409 },
    )
  }

  const [row] = await db
    .update(improvements)
    .set({ status: 'published', archivedAt: null, updatedAt: new Date() })
    .where(and(
      eq(improvements.id, id),
      eq(improvements.customerId, customer.id),
      eq(improvements.status, 'archived'),
    ))
    .returning()

  if (!row) {
    return NextResponse.json({ error: 'Improvement not found or not archived' }, { status: 404 })
  }

  await logEvent({
    name: 'improvement_restored',
    customerId: customer.id,
    properties: { improvementId: id },
  })

  return NextResponse.json({ improvement: row })
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, improvements } from '@/lib/schema'
import { and, eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 65 Phase 2 — Remove (soft-delete) an improvement.
 *
 * POST /api/improvements/[id]/archive
 *
 * Body MUST contain `{ confirmed: true }`. Anything else → 400.
 * The endpoint name is "archive" because the DB state is 'archived'
 * (preserving wb_improvement_matches attribution); the merchant-facing
 * verb is "Remove." Existing match rows are preserved so past
 * attribution stays accurate; the cron just skips removed improvements
 * when picking candidates.
 */

const bodySchema = z.object({
  confirmed: z.literal(true),
})

export async function POST(
  req: Request,
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

  const body = await req.json().catch(() => null)
  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Body must include confirmed: true.' },
      { status: 400 },
    )
  }

  const [row] = await db
    .update(improvements)
    .set({ status: 'archived', archivedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(improvements.id, id),
      eq(improvements.customerId, customer.id),
      eq(improvements.status, 'published'),
    ))
    .returning()

  if (!row) {
    return NextResponse.json({ error: 'Improvement not found or already archived' }, { status: 404 })
  }

  await logEvent({
    name: 'improvement_archived',
    customerId: customer.id,
    properties: { improvementId: id },
  })

  return NextResponse.json({ improvement: row })
}

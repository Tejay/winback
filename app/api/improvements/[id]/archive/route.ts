import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, improvements } from '@/lib/schema'
import { and, eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 65 Phase 2 — Archive (soft-delete) an improvement.
 *
 * POST /api/improvements/[id]/archive
 *
 * Body MUST contain both confirmation flags:
 *   { confirmFeatureRemoved: true, confirmConsequencesUnderstood: true }
 *
 * Either flag missing → 400. This mirrors the two-checkbox UI in the
 * spec mockup. The DB column `archived_at` is set and `status` flips to
 * 'archived'. Existing wb_improvement_matches rows are preserved so
 * past attribution stays accurate; the cron just skips archived
 * improvements when picking candidates.
 */

const bodySchema = z.object({
  confirmFeatureRemoved:         z.literal(true),
  confirmConsequencesUnderstood: z.literal(true),
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
      { error: 'Both confirmFeatureRemoved and confirmConsequencesUnderstood must be true.' },
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

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, improvements } from '@/lib/schema'
import { and, eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 65 Phase 2 — Edit a single improvement.
 *
 * PATCH /api/improvements/[id]
 *   Edits title / description / dateShipped / addressesPattern. Status
 *   changes go through the dedicated /archive and /restore endpoints
 *   so the two-checkbox confirmation can be enforced cleanly.
 *
 * Per the spec: "Edits don't re-trigger matching for already-considered
 * subscribers." This route only updates the row; the matcher's
 * already-matched check (composite PK on wb_improvement_matches) keeps
 * the no-re-trigger guarantee.
 */

const patchSchema = z.object({
  title:            z.string().trim().min(4).max(120).optional(),
  description:      z.string().trim().min(1).max(500).optional(),
  dateShipped:      z.string()
                     .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
                     .refine((d) => new Date(d) <= new Date(), 'dateShipped cannot be in the future')
                     .optional(),
  addressesPattern: z.string().max(200).nullable().optional(),
})

export async function PATCH(
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
  const parsed = patchSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  // Only fields the merchant sent. Don't accidentally clear unset ones.
  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (parsed.data.title !== undefined)            updates.title = parsed.data.title
  if (parsed.data.description !== undefined)      updates.description = parsed.data.description
  if (parsed.data.dateShipped !== undefined)      updates.dateShipped = new Date(parsed.data.dateShipped)
  if (parsed.data.addressesPattern !== undefined) updates.addressesPattern = parsed.data.addressesPattern

  const [row] = await db
    .update(improvements)
    .set(updates)
    .where(and(eq(improvements.id, id), eq(improvements.customerId, customer.id)))
    .returning()

  if (!row) {
    return NextResponse.json({ error: 'Improvement not found' }, { status: 404 })
  }

  await logEvent({
    name: 'improvement_edited',
    customerId: customer.id,
    properties: { improvementId: id, changedFields: Object.keys(updates).filter((k) => k !== 'updatedAt') },
  })

  return NextResponse.json({ improvement: row })
}

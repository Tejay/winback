import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'
import {
  switchCustomerToFlatRate,
  revertCustomerToStandardRate,
} from '@/src/winback/lib/subscription'

/**
 * Spec 77 — Per-customer custom flat-rate billing assignment.
 *
 * POST   /api/admin/customers/[id]/custom-rate  — assign a flat rate
 * DELETE /api/admin/customers/[id]/custom-rate  — revert to standard
 *
 * Both routes:
 *   - require admin auth
 *   - require a typed confirmation string in the body (admin pattern from
 *     other destructive admin actions — e.g., send-reengagement-now)
 *   - delegate the actual work to the subscription.ts helpers
 *   - log an admin_action event with the route + outcome
 */

// $1 minimum (use pilot for free comp); $9,999 ceiling (sanity).
const ASSIGN_BODY_SCHEMA = z.object({
  cents:   z.number().int().min(100).max(999_999),
  confirm: z.literal('SWITCH'),
})

const REVERT_BODY_SCHEMA = z.object({
  confirm: z.literal('REVERT'),
})

async function lookupAdminEmail(userId: string): Promise<string | null> {
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1)
  return row?.email ?? null
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { id: customerId } = await params

  const body = await req.json().catch(() => null)
  const parsed = ASSIGN_BODY_SCHEMA.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input — expected { cents: int 100..999999, confirm: "SWITCH" }', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  const adminEmail = await lookupAdminEmail(auth.userId)
  try {
    const result = await switchCustomerToFlatRate(customerId, parsed.data.cents, { adminEmail })
    await logEvent({
      name: 'admin_action',
      userId: auth.userId,
      customerId,
      properties: {
        action: 'flat_rate_assigned',
        customMonthlyCents: parsed.data.cents,
        priceUpdatedOnStripe: result.priceUpdated,
      },
    })
    return NextResponse.json({ ok: true, customMonthlyCents: parsed.data.cents, priceUpdatedOnStripe: result.priceUpdated })
  } catch (err) {
    console.error('[admin/custom-rate POST] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to assign flat rate' },
      { status: 500 },
    )
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { id: customerId } = await params

  const body = await req.json().catch(() => null)
  const parsed = REVERT_BODY_SCHEMA.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input — expected { confirm: "REVERT" }' },
      { status: 400 },
    )
  }

  const adminEmail = await lookupAdminEmail(auth.userId)
  try {
    const result = await revertCustomerToStandardRate(customerId, { adminEmail })
    await logEvent({
      name: 'admin_action',
      userId: auth.userId,
      customerId,
      properties: {
        action: 'flat_rate_cleared',
        priceUpdatedOnStripe: result.priceUpdated,
      },
    })
    return NextResponse.json({ ok: true, priceUpdatedOnStripe: result.priceUpdated })
  } catch (err) {
    console.error('[admin/custom-rate DELETE] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to revert to standard' },
      { status: 500 },
    )
  }
}

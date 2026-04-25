import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'  // privileged write connection — see specs/25
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/admin/actions/pause-customer
 * Body: { customerId: string, paused: boolean }
 *
 * Toggles customers.pausedAt — the working kill switch already consulted by
 * scheduleExitEmail (spec 20b). All admin mutations log an admin_action
 * event for the future audit-log UI (Phase 3).
 */
export async function POST(req: Request) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const body = await req.json().catch(() => ({}))
  const customerId = String(body.customerId ?? '').trim()
  const paused = Boolean(body.paused)
  if (!customerId) {
    return NextResponse.json({ error: 'customerId required' }, { status: 400 })
  }

  await db
    .update(customers)
    .set({
      pausedAt: paused ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, customerId))

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    customerId,
    properties: { action: 'pause_customer', paused },
  })

  return NextResponse.json({ ok: true, paused })
}

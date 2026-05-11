import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/settings/pause
 * Body: { scope: 'winback' | 'dunning', paused: boolean }
 *
 * Spec 55 — splits the previous all-or-nothing pause into two scopes.
 *   - scope='winback'  → toggles customers.paused_at
 *     Gates: scheduleExitEmail, sendReplyEmail, reengagement cron
 *   - scope='dunning'  → toggles customers.paused_dunning_at
 *     Gates: sendDunningEmail, sendDunningFollowupEmail
 *
 * Cancellations and failed payments continue to be recorded — nothing
 * is lost when paused, only the outbound email is suppressed.
 */
const bodySchema = z.object({
  scope: z.enum(['winback', 'dunning']),
  paused: z.boolean(),
})

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { scope: 'winback' | 'dunning', paused: boolean }" },
      { status: 400 },
    )
  }

  const { scope, paused } = parsed.data
  const now = paused ? new Date() : null

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  await db
    .update(customers)
    .set({
      ...(scope === 'winback' ? { pausedAt: now } : { pausedDunningAt: now }),
      updatedAt: new Date(),
    })
    .where(eq(customers.id, customer.id))

  // Behavioural signal — useful for understanding merchant patterns
  // (e.g., how often pauses happen, which cohort gets paused more,
  // how long pauses tend to last).
  await logEvent({
    name: paused ? 'customer_paused' : 'customer_unpaused',
    customerId: customer.id,
    userId: session.user.id,
    properties: { scope },
  })

  return NextResponse.json({ ok: true, scope, paused })
}

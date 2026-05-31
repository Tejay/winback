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
    .select({
      id:                   customers.id,
      stripeSubscriptionId: customers.stripeSubscriptionId,
    })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  // 2026-05-29 — asymmetric pause/un-pause rule.
  // Pausing is always allowed (an active merchant can pause; a paused
  // merchant can re-pause the other scope; etc.). Un-pausing requires
  // an active platform subscription — without it, sends would be gated
  // off by isCustomerBillingHealthy anyway (activatedAt + no sub →
  // unhealthy), so flipping the toggle would lie about the actual
  // state. Block at the API layer so the toggle never silently fails
  // and the danger-zone UI's "Subscribe to resume" message has teeth.
  if (!paused && !customer.stripeSubscriptionId) {
    // Log the blocked attempt — it's behaviourally interesting (the
    // merchant tried to resume without subscribing, signal of
    // unpause-pressure on the no-sub state). Useful for measuring
    // conversion lift if we ever surface a one-click subscribe path
    // from the danger zone.
    await logEvent({
      name: 'customer_unpause_blocked_no_sub',
      customerId: customer.id,
      userId: session.user.id,
      properties: { scope },
    })
    return NextResponse.json(
      {
        error: 'subscribe_first',
        message:
          'Subscribe before un-pausing — sends are gated on an active subscription.',
      },
      { status: 403 },
    )
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

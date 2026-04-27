import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import {
  cancelPlatformSubscription,
  reactivatePlatformSubscription,
} from '@/src/winback/lib/subscription'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/settings/subscription
 *
 * Body: { action: 'cancel' | 'reactivate' }
 *
 *  - cancel: schedules the platform $99/mo subscription to end at the
 *    current cycle. Customer keeps access through the cycle they paid for;
 *    Stripe's `customer.subscription.deleted` webhook will null out
 *    stripe_subscription_id when the cycle expires.
 *  - reactivate: removes the cancel-at-period-end flag if the customer
 *    changes their mind before the cycle ends.
 *
 * Distinct from /api/settings/delete which deletes the entire workspace
 * and cancels the subscription immediately.
 */
const bodySchema = z.object({
  action: z.enum(['cancel', 'reactivate']),
})

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  try {
    if (parsed.data.action === 'cancel') {
      await cancelPlatformSubscription(customer.id)
      logEvent({
        name: 'platform_subscription_cancel_scheduled',
        customerId: customer.id,
        userId: session.user.id,
      })
    } else {
      await reactivatePlatformSubscription(customer.id)
      logEvent({
        name: 'platform_subscription_reactivated',
        customerId: customer.id,
        userId: session.user.id,
      })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[settings/subscription] action failed:', err)
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'Subscription action failed',
      },
      { status: 500 },
    )
  }
}

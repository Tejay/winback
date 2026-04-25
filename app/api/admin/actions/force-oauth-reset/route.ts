import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * POST /api/admin/actions/force-oauth-reset
 * Body: { customerId: string }
 *
 * Clears the customer's stored Stripe OAuth credentials. The customer is
 * forced through /onboarding/stripe on their next session. Use when:
 *   - support reports the connection is "broken" but Stripe says fine
 *   - we need to roll a customer who's hitting persistent oauth_error events
 *
 * Does NOT touch customer-side Stripe data — only Winback's stored token.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const body = await req.json().catch(() => ({}))
  const customerId = String(body.customerId ?? '').trim()
  if (!customerId) {
    return NextResponse.json({ error: 'customerId required' }, { status: 400 })
  }

  await db
    .update(customers)
    .set({
      stripeAccessToken: null,
      stripeAccountId: null,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, customerId))

  await logEvent({
    name: 'admin_action',
    userId: auth.userId,
    customerId,
    properties: { action: 'force_oauth_reset' },
  })

  return NextResponse.json({ ok: true })
}

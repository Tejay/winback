import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { commitActivation } from '@/src/winback/lib/activation'
import { logEvent } from '@/src/winback/lib/events'
import type { TierKey } from '@/src/winback/lib/tiers'

const ALLOWED_CONFIRMED_TIERS = new Set<TierKey | 'custom'>([
  'starter',
  'growth',
  'scale',
  'custom',
])

/**
 * POST /api/billing/activate
 *
 * Commits the platform Stripe subscription at the customer-confirmed tier.
 * The customer hit "Subscribe at $X/mo" on the activation page; this is
 * the action handler.
 *
 * Request body: { confirmedTier: 'starter' | 'growth' | 'scale' | 'custom' }
 *   - enterprise is rejected (sales-handled).
 *
 * Response shapes:
 *   - 200 { state: 'active', subscriptionId }              — success
 *   - 200 { state: 'awaiting_card', activatedAt }           — redirect to
 *     Stripe Checkout setup mode, then re-POST.
 *   - 200 { state: 'tier_mismatch', recommendedTier }       — server-side
 *     recommended_tier drifted from the value shown to the customer.
 *     Client should reload the activation page and retry.
 *   - 200 { state: 'pilot' | 'no_op' | 'enterprise_handoff' } — nothing to do.
 *   - 400 invalid input.
 *   - 401 unauthenticated.
 *
 * Idempotent: re-calling on an already-active subscription returns the
 * same subscriptionId via ensurePlatformSubscription's existence check.
 */
export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { confirmedTier?: string }
  try {
    body = (await req.json()) as { confirmedTier?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const confirmedTier = body.confirmedTier
  if (
    !confirmedTier ||
    !ALLOWED_CONFIRMED_TIERS.has(confirmedTier as TierKey | 'custom')
  ) {
    return NextResponse.json(
      {
        error:
          'confirmedTier must be one of: starter, growth, scale, custom',
      },
      { status: 400 },
    )
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
    const result = await commitActivation(
      customer.id,
      confirmedTier as TierKey | 'custom',
    )

    logEvent({
      name: 'billing_activate_attempted',
      customerId: customer.id,
      properties: {
        confirmedTier,
        resultState: result.state,
      },
    })

    if (result.state === 'active') {
      return NextResponse.json({
        state: 'active',
        subscriptionId: result.subscriptionId,
        subscriptionCreated: result.subscriptionCreated,
      })
    }
    if (result.state === 'awaiting_card') {
      return NextResponse.json({
        state: 'awaiting_card',
        activatedAt: result.activatedAt.toISOString(),
      })
    }
    if (result.state === 'tier_mismatch') {
      return NextResponse.json({
        state: 'tier_mismatch',
        recommendedTier: result.recommendedTier,
      })
    }
    if (result.state === 'pilot') {
      return NextResponse.json({
        state: 'pilot',
        pilotUntil: result.pilotUntil?.toISOString() ?? null,
      })
    }
    if (result.state === 'enterprise_handoff') {
      return NextResponse.json({ state: 'enterprise_handoff' })
    }
    return NextResponse.json({ state: 'no_op' })
  } catch (err) {
    console.error('[billing/activate] commit failed for', customer.id, err)
    logEvent({
      name: 'billing_activate_failed',
      customerId: customer.id,
      properties: {
        confirmedTier,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    })
    return NextResponse.json(
      {
        error: 'Failed to commit subscription',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}

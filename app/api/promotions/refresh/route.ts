import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { syncActivePromotionsFromStripe } from '@/src/winback/lib/promotions'

/**
 * Spec 78 — manual "Refresh from Stripe" endpoint for /reasons.
 *
 * Webhooks are the primary sync path (promotion_code.created/updated,
 * coupon.updated/deleted). This endpoint is the manual fallback when a
 * merchant just authored a promo in Stripe and doesn't want to wait for
 * the webhook to land (or when an earlier webhook failed delivery).
 *
 * Re-pulls active promotion codes via the merchant's Connect access
 * token; upserts kind='promotion' rows in wb_improvements; archives any
 * previously-published rows that are no longer in the active list.
 */
export async function POST() {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [customer] = await db
    .select({ id: customers.id, stripeAccessToken: customers.stripeAccessToken })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return Response.json({ error: 'No customer record' }, { status: 404 })
  }
  if (!customer.stripeAccessToken) {
    return Response.json({ error: 'Stripe not connected' }, { status: 400 })
  }

  try {
    const result = await syncActivePromotionsFromStripe(customer.id)
    return Response.json({ ok: true, ...result })
  } catch (err) {
    console.error('[api/promotions/refresh] failed', err)
    return Response.json(
      { error: 'Sync failed', message: err instanceof Error ? err.message : 'unknown' },
      { status: 500 },
    )
  }
}

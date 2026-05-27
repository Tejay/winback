import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, improvements } from '@/lib/schema'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 78 followup — single PATCH endpoint that updates either the
 * promotions_enabled toggle, the selected_promotion_improvement_id, or
 * both. Both fields live on wb_customers, both flip from /reasons, both
 * have the same auth shape — keeping them on one route avoids two
 * round-trips when the merchant turns promos on for the first time and
 * picks one in the same flow.
 *
 * Body shape: { enabled?, selectedPromotionImprovementId?, autoModeEnabled? }
 *   - enabled: flips the master toggle. Off = no promo emails at all.
 *   - selectedPromotionImprovementId: id of a published kind='promotion'
 *     improvement owned by this customer, or null to clear. We verify
 *     ownership before writing.
 *   - autoModeEnabled: Spec 80. TRUE = matcher fires automatically for
 *     tier-1 + Price cancellations. FALSE = manual mode (new default);
 *     merchant sends per-subscriber via drawer or bulk modal on
 *     /dashboard. Independent of `enabled` — both must be true for
 *     the matcher path to fire.
 *
 * Path kept at /api/customer/promotions-enabled for backward compatibility
 * with the now-removed /settings toggle; the field is just the body shape.
 */
const Body = z.object({
  enabled:                          z.boolean().optional(),
  selectedPromotionImprovementId:   z.string().uuid().nullable().optional(),
  autoModeEnabled:                  z.boolean().optional(),
}).refine(
  (b) => b.enabled !== undefined
      || b.selectedPromotionImprovementId !== undefined
      || b.autoModeEnabled !== undefined,
  { message: 'must supply enabled, selectedPromotionImprovementId, or autoModeEnabled' },
)

export async function PATCH(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const json = await req.json().catch(() => null)
  const parsed = Body.safeParse(json)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid body' }, { status: 400 })
  }

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return Response.json({ error: 'No customer record' }, { status: 404 })
  }

  // If a selection was provided (non-null), confirm it's actually one of
  // this customer's published promotion rows. Prevents a forged id from
  // pointing the customer at an unrelated improvement (which the matcher
  // would then load and treat as a promo).
  if (parsed.data.selectedPromotionImprovementId) {
    const [target] = await db
      .select({ id: improvements.id })
      .from(improvements)
      .where(and(
        eq(improvements.id, parsed.data.selectedPromotionImprovementId),
        eq(improvements.customerId, customer.id),
        eq(improvements.kind, 'promotion'),
        eq(improvements.status, 'published'),
      ))
      .limit(1)
    if (!target) {
      return Response.json({ error: 'Promotion not found' }, { status: 404 })
    }
  }

  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (parsed.data.enabled !== undefined) {
    update.promotionsEnabled = parsed.data.enabled
  }
  if (parsed.data.selectedPromotionImprovementId !== undefined) {
    update.selectedPromotionImprovementId = parsed.data.selectedPromotionImprovementId
  }
  if (parsed.data.autoModeEnabled !== undefined) {
    update.promoAutoModeEnabled = parsed.data.autoModeEnabled
  }

  await db.update(customers).set(update).where(eq(customers.id, customer.id))

  await logEvent({
    name: 'promotions_settings_changed',
    customerId: customer.id,
    properties: {
      enabled:                        parsed.data.enabled,
      selectedPromotionImprovementId: parsed.data.selectedPromotionImprovementId,
      autoModeEnabled:                parsed.data.autoModeEnabled,
    },
  })

  return Response.json({ ok: true })
}

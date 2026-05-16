import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 78 — flips wb_customers.promotions_enabled for the signed-in
 * merchant. Off by default; merchant opts in from /settings.
 */
const Body = z.object({ enabled: z.boolean() })

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

  await db
    .update(customers)
    .set({ promotionsEnabled: parsed.data.enabled, updatedAt: new Date() })
    .where(eq(customers.id, customer.id))

  await logEvent({
    name: 'promotions_enabled_changed',
    customerId: customer.id,
    properties: { enabled: parsed.data.enabled },
  })

  return Response.json({ ok: true })
}

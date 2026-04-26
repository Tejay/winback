import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, recoveries, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { slugifyWorkspaceName, confirmationMatches } from '@/src/winback/lib/workspace'
import { cancelPlatformSubscription } from '@/src/winback/lib/subscription'

const bodySchema = z.object({ confirmation: z.string().min(1).max(200) })

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
  }

  const userId = session.user.id

  const [customer] = await db
    .select({
      id: customers.id,
      productName: customers.productName,
    })
    .from(customers)
    .where(eq(customers.userId, userId))
    .limit(1)

  const email = session.user.email ?? ''
  const expected = slugifyWorkspaceName(customer?.productName, email)

  if (!confirmationMatches(parsed.data.confirmation, expected)) {
    return NextResponse.json({ error: 'Confirmation does not match' }, { status: 400 })
  }

  // Phase B — cancel any active platform subscription immediately. Stripe
  // issues a prorated final invoice for the unused cycle automatically.
  // Best-effort: if cancellation fails (Stripe down), we still proceed with
  // workspace deletion — the subscription would be cancelled by Stripe's
  // retry of the webhook on next failure, or manually from the dashboard.
  if (customer) {
    try {
      await cancelPlatformSubscription(customer.id, { immediately: true })
    } catch (err) {
      console.error('[delete] subscription cancel failed for', customer.id, err)
    }
  }

  // recoveries has no ON DELETE CASCADE — must delete explicitly first.
  // Everything else cascades from users → customers → churned_subscribers → emails_sent.
  if (customer) {
    await db.delete(recoveries).where(eq(recoveries.customerId, customer.id))
  }
  await db.delete(users).where(eq(users.id, userId))

  return NextResponse.json({ ok: true })
}

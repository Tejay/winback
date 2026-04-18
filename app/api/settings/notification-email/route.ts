import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'

/**
 * Spec 21c — POST /api/settings/notification-email
 * Body: { notificationEmail: string | null }
 * Sets the email address that should receive Winback handoff alerts.
 */

const schema = z.object({
  notificationEmail: z.union([z.string().email(), z.null()]),
})

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
  }

  const result = await db
    .update(customers)
    .set({ notificationEmail: parsed.data.notificationEmail, updatedAt: new Date() })
    .where(eq(customers.userId, session.user.id))
    .returning({ id: customers.id, notificationEmail: customers.notificationEmail })

  if (result.length === 0) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true, notificationEmail: result[0].notificationEmail })
}

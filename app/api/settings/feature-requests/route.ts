import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, featureRequests, users } from '@/lib/schema'
import { eq } from 'drizzle-orm'

/**
 * POST /api/settings/feature-requests
 *
 * Body: { body: string }  — the request text from the textarea.
 *
 * Server resolves customer_id + submitted_by_email from the session
 * (never trusting the client) and stores a row. No outbound email is
 * sent on submit by design — founder reads the table directly. The
 * "we'll email you if we ship it" promise in the form copy is honoured
 * via the dormant shipped_at column + a future close-the-loop cron.
 */

const schema = z.object({
  body: z.string().min(1).max(4000),
})

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Tell us a bit more (1–4000 chars).' },
      { status: 400 },
    )
  }

  // Resolve customer + email server-side. Never trust client.
  const [row] = await db
    .select({
      customerId: customers.id,
      email:      users.email,
    })
    .from(customers)
    .innerJoin(users, eq(users.id, customers.userId))
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  if (!row) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  await db.insert(featureRequests).values({
    customerId:       row.customerId,
    submittedByEmail: row.email,
    body:             parsed.data.body.trim(),
  })

  return NextResponse.json({ ok: true })
}

import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { emailsSent, churnedSubscribers, users } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 70 #2 — admin "Flag email" action.
 *
 * POST { emailId, note? }
 *
 * Writes an `email_flagged` event for prompt-tuning review. Cross-customer
 * protection: rejects when emailId doesn't belong to the subscriber whose
 * inspector page the admin is on (URL :id).
 *
 * Note is optional but encouraged ("wrong reasoning", "topic drift", etc.).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin()
  if ('error' in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { id: subscriberId } = await params
  const body = await req.json().catch(() => ({}))
  const emailId = String(body.emailId ?? '').trim()
  const note = String(body.note ?? '').trim().slice(0, 1000)

  if (!emailId) {
    return NextResponse.json({ error: 'emailId required' }, { status: 400 })
  }

  // Verify the email belongs to this subscriber (defends against URL tampering).
  const [emailRow] = await db
    .select({
      id: emailsSent.id,
      type: emailsSent.type,
      subject: emailsSent.subject,
      subscriberId: emailsSent.subscriberId,
      customerId: churnedSubscribers.customerId,
    })
    .from(emailsSent)
    .innerJoin(churnedSubscribers, eq(churnedSubscribers.id, emailsSent.subscriberId))
    .where(and(
      eq(emailsSent.id, emailId),
      eq(emailsSent.subscriberId, subscriberId),
    ))
    .limit(1)

  if (!emailRow) {
    return NextResponse.json(
      { error: 'Email not found or does not belong to this subscriber' },
      { status: 404 },
    )
  }

  // Optional — admin email for the event payload
  const [admin] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1)

  await logEvent({
    name: 'email_flagged',
    userId: auth.userId,
    customerId: emailRow.customerId,
    properties: {
      subscriberId,
      emailId,
      type: emailRow.type,
      subject: emailRow.subject,
      note: note || null,
      adminEmail: admin?.email ?? null,
    },
  })

  return NextResponse.json({ ok: true })
}

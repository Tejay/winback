import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Spec 22a — POST /api/subscribers/[id]/pause
 *
 * Unified pause/resume/resolve-handoff endpoint.
 *
 * Body:
 *   { action: 'pause', durationDays: number | null, reason?: string }
 *     durationDays null or missing → indefinite
 *   { action: 'resume' }
 *     clears ai_paused_until + ai_paused_at + ai_paused_reason
 *   { action: 'resolve-handoff' }
 *     sets founder_handoff_resolved_at = now AND clears pause fields
 *
 * Auth: session + ownership check.
 */

// Far-future sentinel for indefinite pause
const INDEFINITE_PAUSE = new Date('9999-12-31T00:00:00Z')

const schema = z.union([
  z.object({
    action: z.literal('pause'),
    durationDays: z.union([z.number().int().min(1).max(365), z.null()]).optional(),
    reason: z.string().max(64).optional(),
  }),
  z.object({ action: z.literal('resume') }),
  z.object({ action: z.literal('resolve-handoff') }),
])

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: subscriberId } = await params
  const body = await req.json().catch(() => null)
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', details: parsed.error.issues }, { status: 400 })
  }

  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const [sub] = await db
    .select({
      id: churnedSubscribers.id,
      founderHandoffAt: churnedSubscribers.founderHandoffAt,
    })
    .from(churnedSubscribers)
    .where(
      and(
        eq(churnedSubscribers.id, subscriberId),
        eq(churnedSubscribers.customerId, customer.id),
      ),
    )
    .limit(1)
  if (!sub) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }

  if (parsed.data.action === 'pause') {
    const durationDays = parsed.data.durationDays ?? null
    const pausedUntil = durationDays === null
      ? INDEFINITE_PAUSE
      : new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)
    const reason = parsed.data.reason ?? (sub.founderHandoffAt ? 'handoff' : 'founder_handling')

    await db
      .update(churnedSubscribers)
      .set({
        aiPausedAt: new Date(),
        aiPausedUntil: pausedUntil,
        aiPausedReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(churnedSubscribers.id, subscriberId))

    logEvent({
      name: 'ai_paused',
      customerId: customer.id,
      properties: { subscriberId, durationDays, reason },
    })

    return NextResponse.json({ ok: true, pausedUntil, reason })
  }

  if (parsed.data.action === 'resume') {
    await db
      .update(churnedSubscribers)
      .set({
        aiPausedAt: null,
        aiPausedUntil: null,
        aiPausedReason: null,
        updatedAt: new Date(),
      })
      .where(eq(churnedSubscribers.id, subscriberId))

    logEvent({
      name: 'ai_resumed',
      customerId: customer.id,
      properties: { subscriberId },
    })

    return NextResponse.json({ ok: true })
  }

  // resolve-handoff: set resolved, clear pause too (spec 22a design decision)
  await db
    .update(churnedSubscribers)
    .set({
      founderHandoffResolvedAt: new Date(),
      aiPausedAt: null,
      aiPausedUntil: null,
      aiPausedReason: null,
      updatedAt: new Date(),
    })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'handoff_resolved_manually',
    customerId: customer.id,
    properties: { subscriberId },
  })

  return NextResponse.json({ ok: true })
}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Thin client-fired event endpoint. The server `logEvent()` helper is the
 * primary API — use this route only for events that must fire from the
 * browser (e.g. "button clicked before redirect"). The whitelist below
 * prevents the table from being poisoned by arbitrary client payloads.
 *
 * Identity: we derive `customerId` / `userId` from the session, never from
 * the request body. Unauthenticated requests return 401.
 */

// Only events listed here can be written via this route. Anything else is
// rejected with 400. Extend the whitelist as new client-side events are added.
const CLIENT_EVENT_NAMES = ['connect_clicked'] as const

const trackSchema = z.object({
  name: z.enum(CLIENT_EVENT_NAMES),
  properties: z.record(z.string(), z.unknown()).optional(),
})

/**
 * In-memory per-user rate limit: one event per second. Fine at our current
 * volume; move to a durable store (Redis/Upstash) if we ever deploy multiple
 * compute regions or need cross-instance fairness.
 */
const lastSeenAtByUser = new Map<string, number>()
const MIN_INTERVAL_MS = 1_000

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = Date.now()
  const last = lastSeenAtByUser.get(session.user.id) ?? 0
  if (now - last < MIN_INTERVAL_MS) {
    // Fail quietly — we'd rather drop a duplicate click than 429 a real user.
    return NextResponse.json({ ok: true, rateLimited: true })
  }
  lastSeenAtByUser.set(session.user.id, now)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = trackSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid event' }, { status: 400 })
  }

  // Resolve customerId from the session so the client can't forge it.
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)

  await logEvent({
    name: parsed.data.name,
    customerId: customer?.id ?? null,
    userId: session.user.id,
    properties: parsed.data.properties,
  })

  return NextResponse.json({ ok: true })
}

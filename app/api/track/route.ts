import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logEvent } from '@/src/winback/lib/events'

/**
 * Public, UNAUTHENTICATED client-event endpoint — for the top of the
 * acquisition funnel, which fires before a session exists (anonymous
 * marketing-page traffic). The authenticated sibling `/api/events/track`
 * handles logged-in client events (it 401s anonymous requests).
 *
 * Only the two anonymous funnel events below may be written here — the
 * strict allowlist prevents arbitrary clients from poisoning `wb_events`.
 * No customerId/userId is attached (these are visitor-level). Counts are a
 * directional top-of-funnel signal; light per-IP rate limiting keeps casual
 * floods out, but bot inflation is acceptable (surfaced as such in the UI).
 */

const ANON_EVENT_NAMES = ['landing_viewed', 'cta_clicked'] as const

const trackSchema = z.object({
  event: z.enum(ANON_EVENT_NAMES),
  // Which CTA fired it (hero / pricing / sticky-nav / …). Capped to keep the
  // properties payload bounded.
  location: z.string().max(40).optional(),
})

// In-memory per-IP rate limit: one event/sec. Mirrors /api/events/track's
// per-user limiter. Fine at our volume; move to a durable store if we ever
// run multiple regions.
const lastSeenAtByIp = new Map<string, number>()
const MIN_INTERVAL_MS = 1_000

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  return (xff?.split(',')[0]?.trim()) || req.headers.get('x-real-ip') || 'unknown'
}

export async function POST(req: Request) {
  const ip = clientIp(req)
  const now = Date.now()
  const last = lastSeenAtByIp.get(ip) ?? 0
  if (now - last < MIN_INTERVAL_MS) {
    // Fail quietly — drop the duplicate rather than 429 a real visitor.
    return NextResponse.json({ ok: true, rateLimited: true })
  }
  lastSeenAtByIp.set(ip, now)

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

  await logEvent({
    name: parsed.data.event,
    properties: parsed.data.location ? { location: parsed.data.location } : {},
  })

  return NextResponse.json({ ok: true })
}

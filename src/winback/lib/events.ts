import { db } from '@/lib/db'
import { wbEvents } from '@/lib/schema'

/**
 * First-party event logger. Writes one row to `wb_events` and swallows any
 * error so telemetry failures never break the user flow (a signup that
 * can't write an analytics row should still complete).
 *
 * Prefer calling this from server-side code (route handlers, server
 * components). For client-fired events, POST to `/api/events/track` — that
 * route validates the event name against a whitelist and derives the
 * `customerId` / `userId` from the session so the client can't forge them.
 *
 * Event naming convention: snake_case, `<surface>_<verb>` — e.g.
 * `onboarding_stripe_viewed`, `connect_clicked`, `oauth_completed`.
 */
export async function logEvent(params: {
  name: string
  customerId?: string | null
  userId?: string | null
  properties?: Record<string, unknown>
}): Promise<void> {
  try {
    await db.insert(wbEvents).values({
      name: params.name,
      customerId: params.customerId ?? null,
      userId: params.userId ?? null,
      properties: params.properties ?? {},
    })
  } catch (err) {
    // Telemetry must never break the user flow. Log and move on.
    console.error('[events] logEvent failed', {
      name: params.name,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

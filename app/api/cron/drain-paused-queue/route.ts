import { NextRequest } from 'next/server'
import { runDrainTick } from '@/src/winback/lib/pause-drain'
import { logEvent } from '@/src/winback/lib/events'
import { withCron } from '@/src/winback/lib/cron-wrap'

export const maxDuration = 60

/**
 * Spec 54 — Drain on subscribe.
 *
 * Every 5 minutes, pick up to 50 subscribers whose pause_drain_processed_at
 * is NULL and whose customer is subscribed + activated. Process each one:
 *
 *   - Cancellations + replies → re-classify with daysElapsedSinceEvent
 *     signal, then send / handoff / suppress per AI decision.
 *   - Dunning → template-driven; just send.
 *
 * On success: pause_drain_processed_at = NOW(). Row leaves the queue.
 * On transient failure (per-row): row stays NULL, retried next tick.
 *
 * See specs/54-drain-on-subscribe.md.
 *
 * Schedule: every 5 minutes via vercel.json. Auth: Bearer ${CRON_SECRET}
 * via withCron (Spec 69).
 */
const PER_TICK_LIMIT = 50

export const GET = (req: NextRequest) =>
  withCron('drain-paused-queue', req, async () => {
    try {
      return await runDrainTick(PER_TICK_LIMIT)
    } catch (err) {
      // Preserve the existing pause-drain-specific failure event in addition
      // to the generic cron_run event that withCron will emit.
      const message = err instanceof Error ? err.message : String(err)
      console.error('[pause-drain cron] tick threw:', message)
      await logEvent({
        name: 'pause_drain_tick_failed',
        properties: { error: message },
      }).catch(() => {})
      throw err
    }
  })

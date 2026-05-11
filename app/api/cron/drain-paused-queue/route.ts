import { NextRequest, NextResponse } from 'next/server'
import { runDrainTick } from '@/src/winback/lib/pause-drain'
import { logEvent } from '@/src/winback/lib/events'

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
 * Schedule: every 5 minutes via vercel.json (cron path
 * /api/cron/drain-paused-queue, schedule `* /5 * * * *`).
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Per-tick budget. 50 × ~120ms throttle = ~6s, well under maxDuration.
  const PER_TICK_LIMIT = 50

  try {
    const summary = await runDrainTick(PER_TICK_LIMIT)
    return NextResponse.json(summary)
  } catch (err) {
    // runDrainTick already catches per-row errors. A throw here is a
    // route-level / infra-level failure (DB outage, etc.) — log so we can
    // see it in wb_events and Vercel logs.
    const message = err instanceof Error ? err.message : String(err)
    console.error('[pause-drain cron] tick threw:', message)
    await logEvent({
      name: 'pause_drain_tick_failed',
      properties: { error: message },
    }).catch(() => {})
    return NextResponse.json({ error: 'drain_failed', detail: message }, { status: 500 })
  }
}

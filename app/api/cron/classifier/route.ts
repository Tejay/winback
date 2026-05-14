import { NextRequest } from 'next/server'
import { runClassifierTick } from '@/src/winback/lib/classifier-tick'
import { withCron } from '@/src/winback/lib/cron-wrap'

// Spec 72 — bumped from 60s to 300s after load testing. Empirically
// Anthropic latency is ~4-5s per LLM call (not the ~1.5s I originally
// estimated). A batch of 20 all-signal rows = ~100s; the safety margin
// to 300s tolerates Anthropic slow-day spikes.
export const maxDuration = 300

/**
 * Spec 72 — classifier cron. Picks unclassified rows (regardless of
 * source — webhook inserts and backfill inserts queue uniformly) and
 * runs the LLM + downstream actions (exit email when recent + AI
 * approves).
 *
 * Schedule: every 2 minutes via vercel.json.
 * Batch = 20 rows/tick. Worst case (all-signal) ≈ 100s at ~5s/LLM
 * call; safely under the 300s function ceiling. Typical mixed batches
 * (most rows are silent-churn = no LLM) run in ~20-40s.
 *
 * Auth: Bearer ${CRON_SECRET} via withCron.
 */
export const GET = (req: NextRequest) =>
  withCron('classifier', req, async () => {
    const stats = await runClassifierTick()
    return { stats }
  })

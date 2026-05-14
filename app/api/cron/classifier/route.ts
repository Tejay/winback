import { NextRequest } from 'next/server'
import { runClassifierTick } from '@/src/winback/lib/classifier-tick'
import { withCron } from '@/src/winback/lib/cron-wrap'

export const maxDuration = 60

/**
 * Spec 72 — classifier cron. Picks unclassified rows (regardless of
 * source — webhook inserts and backfill inserts queue uniformly) and
 * runs the LLM + downstream actions (exit email when recent + AI
 * approves).
 *
 * Schedule: every 2 minutes via vercel.json. Bounded batch of 30
 * rows/tick × ~1.5s LLM = ~45s — well under Vercel's 300s ceiling.
 * Auth: Bearer ${CRON_SECRET} via withCron.
 */
export const GET = (req: NextRequest) =>
  withCron('classifier', req, async () => {
    const stats = await runClassifierTick()
    return { stats }
  })

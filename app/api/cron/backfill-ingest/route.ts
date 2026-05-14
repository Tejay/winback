import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { and, isNotNull, isNull } from 'drizzle-orm'
import { runBackfillIngestTick } from '@/src/winback/lib/backfill'
import { withCron } from '@/src/winback/lib/cron-wrap'

export const maxDuration = 60

/**
 * Spec 72 — backfill ingest cron. Picks customers whose backfill is in
 * progress (started_at SET, completed_at NULL) and runs one ingest tick
 * each. Pagination cursor + processing lock are stored on the row so
 * subsequent ticks resume from where the previous one stopped.
 *
 * Schedule: every 5 minutes via vercel.json.
 * Auth: Bearer ${CRON_SECRET} via withCron.
 */
const MAX_CUSTOMERS_PER_FIRE = 10

export const GET = (req: NextRequest) =>
  withCron('backfill-ingest', req, async () => {
    const pending = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(
        isNotNull(customers.backfillStartedAt),
        isNull(customers.backfillCompletedAt),
      ))
      .limit(MAX_CUSTOMERS_PER_FIRE)

    const results = []
    for (const c of pending) {
      const result = await runBackfillIngestTick(c.id)
      results.push({ customerId: c.id, ...result })
    }
    return { processed: pending.length, results }
  })

import { NextRequest } from 'next/server'
import { and, eq, gte, isNotNull, count, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, improvementMatches } from '@/lib/schema'
import { withCron } from '@/src/winback/lib/cron-wrap'
import {
  clusterCancellationsForCustomer,
  MIN_CANCELLATIONS_TO_RUN,
  WINDOW_DAYS,
} from '@/src/winback/lib/cluster-cancellations'

// LLM call per eligible customer; budget bumped to 5 min for batches.
export const maxDuration = 300

/**
 * Spec 79 — weekly cron that clusters each merchant's unmatched
 * cancellations into themes.
 *
 * Scheduled Sundays at 02:00 UTC (low-traffic window) in vercel.json.
 *
 * Eligibility per customer:
 *   • Has ≥ MIN_CANCELLATIONS_TO_RUN unmatched, high-confidence cancellations
 *     in the last WINDOW_DAYS. Customers below the threshold get their
 *     prior themes wiped (so the UI shows the empty state once data falls
 *     off, instead of a stale snapshot).
 *
 * Per-customer LLM cost is one call per run, modest token count.
 *
 * Failures on one customer don't abort the batch — each customer wrapped
 * in its own try/catch. Aggregate counts returned for cron-health
 * monitoring.
 */

async function runClusterCancellationsCron(): Promise<{
  customersScanned:        number
  customersProcessed:      number
  customersSkippedNoData:  number
  customersErrored:        number
  totalThemesWritten:      number
  totalInsightsWritten:    number
}> {
  // Pre-filter to customers with enough recent activity to make the LLM
  // call worth it. The clusterer also re-checks internally (and wipes the
  // table when below threshold), but this saves the round-trip for the
  // long tail of cold/quiet merchants.
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const eligible = await db
    .select({
      customerId:    churnedSubscribers.customerId,
      cancelCount:   count(churnedSubscribers.id).as('cancel_count'),
    })
    .from(churnedSubscribers)
    .where(and(
      gte(churnedSubscribers.cancelledAt, windowStart),
      isNotNull(churnedSubscribers.triggerNeed),
      eq(churnedSubscribers.triggerNeedConfidence, 'high'),
    ))
    .groupBy(churnedSubscribers.customerId)
    .having(sql`count(${churnedSubscribers.id}) >= ${MIN_CANCELLATIONS_TO_RUN}`)

  let processed = 0
  let skippedNoData = 0
  let errored = 0
  let totalThemes = 0
  let totalInsights = 0

  for (const row of eligible) {
    try {
      const result = await clusterCancellationsForCustomer(row.customerId)
      if (result.skipped === 'not_enough_data') {
        skippedNoData++
      } else {
        processed++
        totalThemes += result.themesWritten
        totalInsights += result.postShipInsightsWritten
      }
    } catch (err) {
      errored++
      console.error(`[cluster-cancellations cron] failed for customer ${row.customerId}`, err)
    }
  }

  return {
    customersScanned:       eligible.length,
    customersProcessed:     processed,
    customersSkippedNoData: skippedNoData,
    customersErrored:       errored,
    totalThemesWritten:     totalThemes,
    totalInsightsWritten:   totalInsights,
  }
}

export const GET = (req: NextRequest) =>
  withCron('cluster-cancellations', req, runClusterCancellationsCron)

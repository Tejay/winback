/**
 * Spec 69 — admin Overview cron health widget data source.
 *
 * Returns one row per known cron (from CRON_SCHEDULES) merged with that
 * cron's MOST RECENT cron_run event. The verdict is pure staleness:
 *   - never-run : no cron_run event has ever been recorded for it
 *   - failed    : its latest run errored (ok = false)
 *   - stale     : its latest run is older than the cron's maxIntervalSecs
 *   - ok        : otherwise (ran within its expected interval)
 *
 * We fetch exactly the latest run per cron via DISTINCT ON, so the result
 * is one row per cron regardless of how many runs are stored. (The prior
 * flat `ORDER BY name … LIMIT 500` could be entirely consumed by a single
 * high-volume cron — e.g. backfill-ingest with 6k+ rows — starving every
 * other cron's latest run out of the window and mislabelling healthy crons
 * as "never run".)
 */
import { sql, eq, desc } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { wbEvents } from '../schema'
import { CRON_SCHEDULES } from '../cron-schedules'

export type CronStatus = 'ok' | 'failed' | 'stale' | 'never-run'

export interface CronHealthRow {
  name: string
  displayName: string
  label: string
  purpose: string
  staleImpact: string
  status: CronStatus
  lastRunAt: Date | null
  durationMs: number | null
  errorMessage: string | null
}

export async function getCronHealth(): Promise<CronHealthRow[]> {
  // Latest cron_run event per cron name. DISTINCT ON ((name)) with the
  // matching leading ORDER BY keeps the newest run for each cron and
  // nothing else — bounded to one row per cron, immune to event volume.
  const rows = await getDbReadOnly()
    .selectDistinctOn([sql`(${wbEvents.properties}->>'name')`], {
      name: sql<string>`(${wbEvents.properties}->>'name')`,
      ok: sql<boolean>`(${wbEvents.properties}->>'ok')::boolean`,
      durationMs: sql<number>`COALESCE((${wbEvents.properties}->>'durationMs')::int, 0)`,
      errorMessage: sql<string | null>`(${wbEvents.properties}->>'errorMessage')`,
      createdAt: wbEvents.createdAt,
    })
    .from(wbEvents)
    .where(eq(wbEvents.name, 'cron_run'))
    .orderBy(sql`(${wbEvents.properties}->>'name')`, desc(wbEvents.createdAt))

  const byName = new Map(rows.map((r) => [r.name, r]))

  const now = Date.now()
  return CRON_SCHEDULES.map((c) => {
    const latest = byName.get(c.name)
    if (!latest) {
      return {
        name: c.name,
        displayName: c.displayName ?? c.name,
        label: c.label,
        purpose: c.purpose,
        staleImpact: c.staleImpact,
        status: 'never-run' as CronStatus,
        lastRunAt: null,
        durationMs: null,
        errorMessage: null,
      }
    }

    const ageSecs = (now - latest.createdAt.getTime()) / 1000
    let status: CronStatus
    if (!latest.ok) status = 'failed'
    else if (ageSecs > c.maxIntervalSecs) status = 'stale'
    else status = 'ok'

    return {
      name: c.name,
      displayName: c.displayName ?? c.name,
      label: c.label,
      purpose: c.purpose,
      staleImpact: c.staleImpact,
      status,
      lastRunAt: latest.createdAt,
      durationMs: latest.durationMs,
      errorMessage: latest.errorMessage,
    }
  })
}

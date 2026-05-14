/**
 * Spec 69 — admin Overview cron health widget data source.
 *
 * Returns one row per known cron (from CRON_SCHEDULES) with the latest
 * cron_run event details merged in. Rows where we've never seen a
 * cron_run event come back as `status: 'never-run'`.
 */
import { sql, eq, desc } from 'drizzle-orm'
import { getDbReadOnly } from '../db'
import { wbEvents } from '../schema'
import { CRON_SCHEDULES } from '../cron-schedules'

export type CronStatus = 'ok' | 'failed' | 'stale' | 'never-run'

export interface CronHealthRow {
  name: string
  label: string
  status: CronStatus
  lastRunAt: Date | null
  durationMs: number | null
  errorMessage: string | null
}

export async function getCronHealth(): Promise<CronHealthRow[]> {
  // Latest cron_run event per cron name. PG's DISTINCT ON gets us one row
  // per group with the ordering we want.
  const rows = await getDbReadOnly()
    .select({
      name: sql<string>`(${wbEvents.properties}->>'name')`,
      ok: sql<boolean>`(${wbEvents.properties}->>'ok')::boolean`,
      durationMs: sql<number>`COALESCE((${wbEvents.properties}->>'durationMs')::int, 0)`,
      errorMessage: sql<string | null>`(${wbEvents.properties}->>'errorMessage')`,
      createdAt: wbEvents.createdAt,
    })
    .from(wbEvents)
    .where(eq(wbEvents.name, 'cron_run'))
    .orderBy(sql`(${wbEvents.properties}->>'name')`, desc(wbEvents.createdAt))
    .limit(500)

  // Reduce to latest-per-name in JS (PG DISTINCT ON would also work but
  // requires raw SQL; ORDER + small LIMIT + Map is simpler given <100
  // rows/day for our 6 crons).
  const latestByName = new Map<string, typeof rows[number]>()
  for (const r of rows) {
    if (!latestByName.has(r.name)) latestByName.set(r.name, r)
  }

  const now = Date.now()
  return CRON_SCHEDULES.map((c) => {
    const latest = latestByName.get(c.name)
    if (!latest) {
      return {
        name: c.name,
        label: c.label,
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
      label: c.label,
      status,
      lastRunAt: latest.createdAt,
      durationMs: latest.durationMs,
      errorMessage: latest.errorMessage,
    }
  })
}

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

export type CronStatus = 'ok' | 'failed' | 'stale' | 'slow' | 'never-run'

export interface CronHealthRow {
  name: string
  displayName: string
  label: string
  purpose: string
  staleImpact: string
  status: CronStatus
  lastRunAt: Date | null
  durationMs: number | null
  /** Rolling avg of last 10 ok runs' durationMs — null when <2 prior runs. */
  avgDurationMs: number | null
  errorMessage: string | null
}

/** Threshold for 'slow' status: latest run is more than 3× the rolling avg. */
const SLOW_MULTIPLIER = 3
/** Minimum prior-run sample size before slow-detection kicks in. */
const SLOW_MIN_SAMPLE = 2

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

  // Group by cron name. Keep the latest as `latest`; accumulate the
  // next N successful prior runs as the slow-detection baseline.
  type Run = typeof rows[number]
  const byName = new Map<string, { latest: Run; priorOkRuns: Run[] }>()
  for (const r of rows) {
    const slot = byName.get(r.name)
    if (!slot) {
      byName.set(r.name, { latest: r, priorOkRuns: [] })
      continue
    }
    if (r.ok && slot.priorOkRuns.length < 10) {
      slot.priorOkRuns.push(r)
    }
  }

  const now = Date.now()
  return CRON_SCHEDULES.map((c) => {
    const slot = byName.get(c.name)
    if (!slot) {
      return {
        name: c.name,
        displayName: c.displayName ?? c.name,
        label: c.label,
        purpose: c.purpose,
        staleImpact: c.staleImpact,
        status: 'never-run' as CronStatus,
        lastRunAt: null,
        durationMs: null,
        avgDurationMs: null,
        errorMessage: null,
      }
    }
    const { latest, priorOkRuns } = slot
    const ageSecs = (now - latest.createdAt.getTime()) / 1000
    const avgDurationMs = priorOkRuns.length >= SLOW_MIN_SAMPLE
      ? Math.round(priorOkRuns.reduce((s, r) => s + r.durationMs, 0) / priorOkRuns.length)
      : null

    let status: CronStatus
    if (!latest.ok) {
      status = 'failed'
    } else if (ageSecs > c.maxIntervalSecs) {
      status = 'stale'
    } else if (
      avgDurationMs !== null
      && avgDurationMs > 0
      && latest.durationMs > SLOW_MULTIPLIER * avgDurationMs
    ) {
      // Slow: this run took ≥3× the rolling-avg of recent successful
      // runs. Outage in progress, not an outage yet — useful early
      // warning before the cron starts timing out altogether.
      status = 'slow'
    } else {
      status = 'ok'
    }
    return {
      name: c.name,
      displayName: c.displayName ?? c.name,
      label: c.label,
      purpose: c.purpose,
      staleImpact: c.staleImpact,
      status,
      lastRunAt: latest.createdAt,
      durationMs: latest.durationMs,
      avgDurationMs,
      errorMessage: latest.errorMessage,
    }
  })
}

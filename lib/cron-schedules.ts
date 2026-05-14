/**
 * Spec 69 — single source of truth for cron schedule metadata used by
 * the admin Overview cron-health widget. Mirrors vercel.json. If a new
 * cron is added there, add it here too (and wrap its route in
 * `withCron` so it emits cron_run events).
 *
 * `maxIntervalSecs` is the threshold above which "last run was N seconds
 * ago" should flag as STALE. Daily crons get 1.5× day for tolerance of
 * the next scheduled run not having happened yet plus a small buffer.
 */
export interface CronSchedule {
  name: string
  cron: string
  label: string
  maxIntervalSecs: number
}

const DAY = 24 * 60 * 60
const HOUR = 60 * 60

export const CRON_SCHEDULES: ReadonlyArray<CronSchedule> = [
  { name: 'reengagement',        cron: '0 9 * * *',   label: 'Daily 09:00 UTC',   maxIntervalSecs: DAY * 1.5 },
  { name: 'onboarding-followup', cron: '30 9 * * *',  label: 'Daily 09:30 UTC',   maxIntervalSecs: DAY * 1.5 },
  { name: 'dunning-followup',    cron: '0 8 * * *',   label: 'Daily 08:00 UTC',   maxIntervalSecs: DAY * 1.5 },
  { name: 'cumulative-revenue',  cron: '0 3 * * *',   label: 'Daily 03:00 UTC',   maxIntervalSecs: DAY * 1.5 },
  { name: 'billing-nudge',       cron: '0 10 * * *',  label: 'Daily 10:00 UTC',   maxIntervalSecs: DAY * 1.5 },
  { name: 'drain-paused-queue',  cron: '*/5 * * * *', label: 'Every 5 minutes',   maxIntervalSecs: 15 * 60 },
]

// HOUR is exported for tests that want to construct stale-thresholds in a
// readable way without redefining the constant.
export { HOUR, DAY }

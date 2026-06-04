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
  /** Human-readable name for the admin UI. Falls back to `name` when absent. */
  displayName?: string
  /** One sentence — what this cron does in plain English. */
  purpose: string
  /** One sentence — consequence if this cron stops running. */
  staleImpact: string
}

const DAY = 24 * 60 * 60
const HOUR = 60 * 60

export const CRON_SCHEDULES: ReadonlyArray<CronSchedule> = [
  {
    name: 'reengagement',
    displayName: 'Reasons re-engagement',
    cron: '0 9 * * *',
    label: 'Daily 09:00 UTC',
    maxIntervalSecs: DAY * 1.5,
    purpose: 'Matches cancelled subscribers against the merchant\'s active improvements and sends targeted re-engagement emails.',
    staleImpact: 'No new re-engagement emails fire. Eligible subscribers still get sent on the next successful run — no data loss.',
  },
  {
    name: 'onboarding-followup',
    displayName: 'Onboarding follow-up',
    cron: '30 9 * * *',
    label: 'Daily 09:30 UTC',
    maxIntervalSecs: DAY * 1.5,
    purpose: 'Sends day-3 onboarding nudge, day-83 deletion warning, day-90 cascade prune, and day-23 pilot-ending heads-up emails.',
    staleImpact: 'New merchants don\'t get reminded to finish setup; stale accounts don\'t get pruned. Catches up on the next run.',
  },
  {
    name: 'dunning-followup',
    displayName: 'Dunning follow-up',
    cron: '0 8 * * *',
    label: 'Daily 08:00 UTC',
    maxIntervalSecs: DAY * 1.5,
    purpose: 'Sends T2/T3 dunning emails ~24h before Stripe\'s next retry attempt on a failed payment.',
    staleImpact: 'Subscribers don\'t get the heads-up between Stripe retries. Stripe still retries; recovery rate drops because users miss the email asking them to update their card.',
  },
  {
    name: 'cumulative-revenue',
    displayName: 'Cumulative revenue',
    cron: '0 3 * * *',
    label: 'Daily 03:00 UTC',
    maxIntervalSecs: DAY * 1.5,
    purpose: 'Recomputes each merchant\'s cumulative_revenue_saved_cents from their recoveries.',
    staleImpact: 'Merchant dashboard "revenue saved" number is stale. No functional impact — purely a display lag.',
  },
  {
    name: 'billing-nudge',
    displayName: 'Subscribe billing nudge',
    cron: '0 10 * * *',
    label: 'Daily 10:00 UTC',
    maxIntervalSecs: DAY * 1.5,
    purpose: 'Sends day-7 / day-30 / monthly billing reports to post-trial merchants who haven\'t added a card yet.',
    staleImpact: 'Merchants don\'t get reminded to add a card; trial → paid conversions stall. Each missed run can be picked up next day but cumulative delay hurts conversion.',
  },
  {
    name: 'drain-paused-queue',
    displayName: 'Activation backlog drain',
    cron: '*/5 * * * *',
    label: 'Every 5 minutes',
    maxIntervalSecs: 15 * 60,
    purpose: 'Processes subscribers whose webhook arrived while billing was paused — re-classifies cancellations/replies and sends queued dunning emails.',
    staleImpact: 'Cancellations and replies that came in during a paused billing window stay in the queue. No data loss but per-subscriber actions are delayed.',
  },
  {
    name: 'backfill-ingest',
    displayName: 'Backfill ingest',
    cron: '*/5 * * * *',
    label: 'Every 5 minutes',
    maxIntervalSecs: 15 * 60,
    purpose: 'Pulls cancellations from Stripe for each merchant whose backfill is in progress and inserts raw rows. Spec 72 producer.',
    staleImpact: 'New merchants who just connected Stripe will see import progress stall. Already-imported subscribers are unaffected.',
  },
  {
    name: 'classifier',
    displayName: 'Classifier',
    cron: '*/2 * * * *',
    label: 'Every 2 minutes',
    maxIntervalSecs: 6 * 60,
    purpose: 'Picks unclassified subscribers, runs the LLM, persists tier/triggerNeed/etc, and sends an exit email if the cancellation is recent and the AI doesn\'t suppress.',
    staleImpact: 'New cancellations sit in the queue with classified_at=NULL. Exit emails are delayed; merchant dashboard shows them as "pending classification".',
  },
  {
    name: 'fx-refresh',
    displayName: 'FX rate refresh',
    cron: '0 2 * * *',
    label: 'Daily 02:00 UTC',
    maxIntervalSecs: DAY * 1.5,
    purpose: 'Refreshes USD-base FX rates from the configured provider into wb_fx_rates. Powers non-USD subscription conversion in MRR computation.',
    staleImpact: 'Non-USD subscriptions convert at stale rates (still permitted up to 7d, then admin-alerted). No customer is blocked.',
  },
  {
    name: 'mrr-snapshot',
    displayName: 'MRR snapshot + tier eval',
    cron: '0 3 * * 0',
    label: 'Weekly Sunday 03:00 UTC',
    maxIntervalSecs: DAY * 8,
    purpose: 'Per connected account: compute MRR from Stripe, write a snapshot, recompute smoothed MRR, re-evaluate recommended_tier, fire upgrade/downgrade prompts when sustain windows elapse.',
    staleImpact: 'Tier recommendations and upgrade/downgrade prompts freeze at the last successful run. Customers continue paying their billed_tier — no economic impact, just stale advice.',
  },
  {
    name: 'red-light-check',
    displayName: 'Red-light email alert',
    cron: '*/5 * * * *',
    label: 'Every 5 minutes',
    maxIntervalSecs: 15 * 60,
    purpose: 'Recomputes /admin red-lights and emails ADMIN_ALERT_EMAIL when a rule trips, with a 15-min per-rule cooldown.',
    staleImpact: 'Red-light email alerts stop firing. The /admin Now page still surfaces lights on every 30s client poll, but no one gets paged unless they have the tab open.',
  },
]

// HOUR is exported for tests that want to construct stale-thresholds in a
// readable way without redefining the constant.
export { HOUR, DAY }

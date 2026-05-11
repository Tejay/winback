-- Spec 51 — Billing trigger after first recovery
--
-- Adds four timestamp columns to wb_customers for the post-trial paused
-- state UX:
--
--   billing_nudge_day7_sent_at           — idempotency for day-7 nudge (set once)
--   billing_nudge_day30_sent_at          — idempotency for day-30 nudge (set once)
--   billing_monthly_report_last_sent_at  — cadence anchor for monthly report
--                                          (updates each send; ≥28 days between)
--   billing_emails_opted_out_at          — merchant opted out of billing emails
--                                          (single-set suppression flag)
--
-- The paused state itself is derived: activatedAt IS NOT NULL AND
-- stripeSubscriptionId IS NULL. No new column for state.
--
-- All idempotent (ADD COLUMN IF NOT EXISTS). Safe to re-run.

ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS billing_nudge_day7_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS billing_nudge_day30_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS billing_monthly_report_last_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS billing_emails_opted_out_at TIMESTAMP;

-- Index supports the cron's daily WHERE clause efficiently.
CREATE INDEX IF NOT EXISTS idx_wb_customers_billing_paused
  ON wb_customers (activated_at, stripe_subscription_id)
  WHERE activated_at IS NOT NULL AND stripe_subscription_id IS NULL;

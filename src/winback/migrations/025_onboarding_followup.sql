-- Spec 30 — Onboarding follow-up + dormant-account cleanup.
--
-- Adds idempotency timestamps for the two follow-up emails sent by
-- /api/cron/onboarding-followup:
--   * onboarding_nudge_sent_at:     Day-3 "still want to set up?" email
--   * deletion_warning_sent_at:     Day-83 "we'll delete in 7 days" email
--
-- A partial index narrows the daily cron's nudge-pass scan to the active
-- cohort (dormant customers who haven't been nudged yet). The warning pass
-- is small enough by definition (Day 83-89, no Stripe) that it doesn't
-- need its own index.

ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS onboarding_nudge_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS deletion_warning_sent_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS wb_customers_onboarding_nudge_idx
  ON wb_customers (created_at)
  WHERE stripe_account_id IS NULL AND onboarding_nudge_sent_at IS NULL;

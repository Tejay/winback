-- Spec 33 — Multi-touch dunning sequence (3 touches, retry-aware).
--
-- Adds the state machine the daily /api/cron/dunning-followup needs to
-- send T2 (~24h before Stripe's retry #2) and T3 (~24h before Stripe's
-- final retry). The webhook captures Stripe's next_payment_attempt on
-- every payment_failed event and stores it here so the cron can find
-- rows whose retry is imminent.
--
-- dunning_state values:
--   'awaiting_retry'           — payment failed, more retries expected
--   'final_retry_pending'      — Stripe is on attempt #3; next retry is the last
--   'recovered_during_dunning' — payment_succeeded fired in the dunning window
--   'churned_during_dunning'   — Stripe gave up (next_payment_attempt: null)

ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS next_payment_attempt_at  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dunning_touch_count      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dunning_last_touch_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dunning_state            TEXT;

-- Partial index — only rows actively in the dunning sequence.
-- Keeps the cron's eligibility query cheap regardless of the table's overall size.
CREATE INDEX IF NOT EXISTS wb_churned_dunning_active_idx
  ON wb_churned_subscribers (next_payment_attempt_at)
  WHERE dunning_state IN ('awaiting_retry', 'final_retry_pending')
    AND dunning_touch_count < 3;

-- Extend Spec-28's email idempotency partial unique index to include the
-- new T2/T3 types. Drop-and-recreate is the simplest path; no rows exist
-- with these types yet so there's no risk of conflict.
DROP INDEX IF EXISTS idx_emails_sent_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_sent_unique
  ON wb_emails_sent (subscriber_id, type)
  WHERE type IN ('exit', 'dunning', 'win_back', 'dunning_t2', 'dunning_t3');

-- Migration 011: Time decay re-engagement
-- Adds columns to track fallback re-engagement window and attempts.

ALTER TABLE wb_churned_subscribers
  ADD COLUMN fallback_days        INTEGER DEFAULT 90,
  ADD COLUMN reengagement_sent_at TIMESTAMPTZ,
  ADD COLUMN reengagement_count   INTEGER NOT NULL DEFAULT 0;

-- Backfill existing rows with the default
UPDATE wb_churned_subscribers SET fallback_days = 90 WHERE fallback_days IS NULL;

-- Partial index for the daily cron query — only rows that could be eligible
CREATE INDEX idx_churned_reengagement_eligible
  ON wb_churned_subscribers (cancelled_at, fallback_days)
  WHERE status IN ('pending', 'contacted')
    AND fallback_days IS NOT NULL
    AND do_not_contact = FALSE;

-- Spec 72 — producer/consumer backfill + classifier
--
-- Splits Stripe ingest from LLM classification into two crons. Adds
-- pagination cursor + processing lock on wb_customers, classified_at +
-- classify_attempts on wb_churned_subscribers, plus a compound UNIQUE
-- index to close the race-with-webhook gap.

-- 1. wb_customers — pagination state + atomic claim lock
ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS backfill_cursor TEXT,
  ADD COLUMN IF NOT EXISTS backfill_processing_at TIMESTAMPTZ;

-- 2. wb_churned_subscribers — pending-classification queue
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS classified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS classify_attempts INTEGER NOT NULL DEFAULT 0;

-- Pending-classify queue index — partial index over the hot path.
CREATE INDEX IF NOT EXISTS idx_wb_churned_subscribers_pending_classify
  ON wb_churned_subscribers (created_at)
  WHERE classified_at IS NULL;

-- Closes the race-with-webhook gap. Webhook + backfill can run on the
-- same Stripe customer simultaneously without producing duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_churned_subscribers_customer_stripe
  ON wb_churned_subscribers (customer_id, stripe_customer_id);

-- 3. One-time data backfill: existing classified rows are marked done so
-- the new classifier cron doesn't re-process them. Idempotent.
UPDATE wb_churned_subscribers
SET classified_at = COALESCE(updated_at, created_at)
WHERE tier IS NOT NULL AND classified_at IS NULL;

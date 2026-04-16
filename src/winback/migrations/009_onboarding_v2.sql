-- Add source column to track how subscriber entered the system
ALTER TABLE wb_churned_subscribers
  ADD COLUMN source TEXT NOT NULL DEFAULT 'webhook';

-- Add backfill progress tracking to customers
ALTER TABLE wb_customers
  ADD COLUMN backfill_total INTEGER DEFAULT 0,
  ADD COLUMN backfill_processed INTEGER DEFAULT 0,
  ADD COLUMN backfill_started_at TIMESTAMPTZ,
  ADD COLUMN backfill_completed_at TIMESTAMPTZ;

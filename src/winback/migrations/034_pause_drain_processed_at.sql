-- Spec 54 — Drain on subscribe: per-row state column + partial index.
--
-- After a merchant subscribes, the scheduled cron at
-- /api/cron/drain-paused-queue picks up subscribers whose
-- pause_drain_processed_at IS NULL and processes them one at a time.
-- Setting this column to NOW() removes the row from the queue.
--
-- The partial index supports the cron filter efficiently — only
-- unprocessed rows are indexed, so the query scales with backlog
-- size rather than table size.

ALTER TABLE wb_churned_subscribers
ADD COLUMN IF NOT EXISTS pause_drain_processed_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_wb_churned_subscribers_drain_queue
ON wb_churned_subscribers (customer_id, pause_drain_processed_at)
WHERE pause_drain_processed_at IS NULL;

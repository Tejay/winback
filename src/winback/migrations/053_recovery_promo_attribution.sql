-- Spec 79 — Promo code attribution on recovery rows.
--
-- The old applied_promotion_code_id column on wb_recoveries was dropped
-- in migration 051 because it was entangled with the deleted perf-fee
-- ingest path. Restoring a join from a recovery back to the promotion
-- improvement that drove it, so the dashboard chip and the per-code
-- 30d metric on /reasons can render real data.
--
-- FK to wb_improvements rather than a raw string, so the schema is
-- clean and Stripe-code changes propagate via the improvement row.
-- Partial index because most recoveries are not promo-driven and only
-- the chip lookup + per-code metric query need the index.

ALTER TABLE wb_recoveries
  ADD COLUMN IF NOT EXISTS applied_improvement_id UUID
    REFERENCES wb_improvements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_recoveries_applied_improvement_id
  ON wb_recoveries(applied_improvement_id)
  WHERE applied_improvement_id IS NOT NULL;

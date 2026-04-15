-- 006_pause.sql
-- Adds a customer-level pause switch. When paused_at is NOT NULL, Winback will
-- not send any new win-back emails on that customer's behalf. Cancellations
-- continue to be recorded in wb_churned_subscribers so nothing is lost.

ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_wb_customers_paused_at
  ON wb_customers (paused_at)
  WHERE paused_at IS NOT NULL;

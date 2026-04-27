-- Phase D — Hardening: indexes for hot queries + drop truly dead columns.
--
-- 1. Indexes on wb_recoveries for the two hot paths:
--    a) chargePendingPerformanceFees: (customer_id) WHERE pending+win_back
--    b) maybeRefundRecentWinBack: (subscriber_id, perf_fee_charged_at DESC)
--       WHERE charged-but-not-refunded
--    Partial indexes keep them small.
--
-- 2. Drop columns that no production code reads:
--    - wb_recoveries.still_active     (legacy in-window flag — orphaned by Phase B)
--    - wb_recoveries.last_checked_at  (paired with still_active — orphaned)
--
-- NOT dropping: wb_customers.paused_at (read by email.ts), recovery_likelihood
-- (used by founder-handoff-email body), trigger_keyword/win_back_subject/
-- win_back_body (still emitted by classifier output contract; cheap to keep).

-- Indexes
CREATE INDEX IF NOT EXISTS idx_wb_recoveries_pending_winback
  ON wb_recoveries (customer_id)
  WHERE recovery_type = 'win_back'
    AND perf_fee_charged_at IS NULL
    AND perf_fee_refunded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_wb_recoveries_refund_window
  ON wb_recoveries (subscriber_id, perf_fee_charged_at DESC)
  WHERE recovery_type = 'win_back'
    AND perf_fee_charged_at IS NOT NULL
    AND perf_fee_refunded_at IS NULL;

-- Vestigial columns
ALTER TABLE wb_recoveries
  DROP COLUMN IF EXISTS still_active,
  DROP COLUMN IF EXISTS last_checked_at;

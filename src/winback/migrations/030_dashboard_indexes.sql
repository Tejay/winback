-- Spec 40 polish — dashboard query indexes.
--
-- /api/stats runs ~13 SQL queries per 3-second poll. The new aggregations
-- added by Spec 40 (top reasons, top decline codes, in-dunning counts,
-- monthly buckets, daily sparkline series) all filter by customer_id and
-- then by either a time column or dunning_state. Without these composite
-- indexes Postgres falls back to scanning every row in the customer
-- partition for each query — fine at <1k rows, increasingly slow at 50k+.
--
-- Two indexes cover the new aggregations cheaply:
--
-- 1. (customer_id, cancelled_at DESC)  — used by:
--      - Top-reasons-this-month aggregation (winBackReasonRows)
--      - Subscriber-list default sort
--      - Recovery-rate denominators that filter on cancelled_at
--      - Anything that scrolls cancellations by recency
--    The DESC matches the dominant access pattern (newest first).
--
-- 2. (customer_id, dunning_state)      — used by:
--      - In-dunning count
--      - Final-retry filter chip count
--      - Lost-during-dunning count
--      - The /api/subscribers payment-recovery cohort sort
--    Most rows have dunning_state = NULL (voluntary cancels). A partial
--    index on `WHERE dunning_state IS NOT NULL` would be even tighter,
--    but the simple composite handles every state including the four
--    active values; small DB so the marginal saving isn't worth it yet.
--
-- Both use IF NOT EXISTS so re-running the migration is a no-op.
-- CREATE INDEX (no CONCURRENTLY) is fine here — the indexed columns
-- are already low-cardinality enough that index build is fast at
-- pre-launch sizes; if the table grows large before this lands, switch
-- to CONCURRENTLY in a follow-up.

CREATE INDEX IF NOT EXISTS wb_churned_customer_cancelled_at_idx
  ON wb_churned_subscribers (customer_id, cancelled_at DESC);

CREATE INDEX IF NOT EXISTS wb_churned_customer_dunning_state_idx
  ON wb_churned_subscribers (customer_id, dunning_state);

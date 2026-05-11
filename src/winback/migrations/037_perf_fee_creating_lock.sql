-- Spec 58 — Performance-fee race-fence.
--
-- chargePerformanceFee() previously used a check-then-act pattern that let
-- two concurrent ensureActivation calls (Spec 52 scenario: /billing/success
-- + checkout.session.completed webhook firing in parallel) both create
-- Stripe invoice items for the same recovery — silently double-billing the
-- merchant.
--
-- This column is the TTL'd lock for the new atomic claim-and-act path.
-- Set when a caller claims the right to create the Stripe invoice item;
-- cleared on success atomically with writing perf_fee_stripe_item_id, or
-- auto-expires after 30s for crash recovery.
ALTER TABLE wb_recoveries
  ADD COLUMN IF NOT EXISTS perf_fee_creating_at TIMESTAMP;

COMMENT ON COLUMN wb_recoveries.perf_fee_creating_at IS
  'Spec 58 — TTL''d lock for race-safe perf-fee charging. '
  'NULL = not claimed; timestamp = a caller is mid-create. '
  'Cleared on success atomically with perf_fee_stripe_item_id.';

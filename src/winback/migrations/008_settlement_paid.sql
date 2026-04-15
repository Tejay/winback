-- Hooks the settlement flow up to Stripe Checkout instead of a manual ops
-- email. Two schema changes:
--
-- 1. wb_customers.settlement_paid_at — once set, this customer has paid out
--    all 12-month attribution obligations. computeOpenObligations() returns
--    0 regardless of live recoveries, which unlocks Gates 1-3 on
--    /settings/delete.
--
-- 2. wb_settlement_requests.stripe_session_id — the Stripe Checkout Session
--    id, so the success-return handler can verify payment_status='paid'
--    before marking the customer as settled.

ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS settlement_paid_at TIMESTAMPTZ NULL;

ALTER TABLE wb_settlement_requests
  ADD COLUMN IF NOT EXISTS stripe_session_id TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wb_settlement_requests_session
  ON wb_settlement_requests (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

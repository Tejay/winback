-- Tracks merchant-initiated settlement requests from the delete flow.
-- A row is created when a merchant with open obligations clicks
-- "Request settlement invoice" on /settings/delete. Ops reviews it,
-- issues a Stripe invoice manually, then flips status='settled' so the
-- merchant's next visit to /settings/delete sees zero obligations and
-- the delete flow unlocks.
--
-- Superseded by Phase 9.2 (automated invoice cron).

CREATE TABLE IF NOT EXISTS wb_settlement_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES wb_customers(id) ON DELETE CASCADE,
  obligation_cents    INTEGER NOT NULL,
  live_count          INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',  -- pending | settled | cancelled
  requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at          TIMESTAMPTZ NULL,
  notes               TEXT NULL
);

-- Fast lookup for "does this customer have an unsettled request?"
CREATE INDEX IF NOT EXISTS idx_wb_settlement_requests_customer_status
  ON wb_settlement_requests (customer_id, status);

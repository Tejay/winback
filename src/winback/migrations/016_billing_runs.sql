-- Spec 24a — Monthly invoice cron idempotency + audit table.
-- One row per (customer, month) representing a billing attempt.

CREATE TABLE IF NOT EXISTS wb_billing_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES wb_customers(id) ON DELETE CASCADE,
  period_yyyymm     text NOT NULL,   -- 'YYYY-MM' period COVERED (in arrears)
  stripe_invoice_id text,
  amount_cents      integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending',
  -- status: 'pending' | 'paid' | 'failed' | 'skipped_no_obligations' | 'skipped_no_card'
  line_item_count   integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finalized_at      timestamptz,
  paid_at           timestamptz,
  UNIQUE (customer_id, period_yyyymm)
);

-- Lookup by stripe invoice id (webhook reconciliation)
CREATE INDEX IF NOT EXISTS idx_billing_runs_invoice
  ON wb_billing_runs (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- Per-customer history (Settings page "all invoices" use case — though
-- we show Stripe-side data there, this is for internal queries/audit).
CREATE INDEX IF NOT EXISTS idx_billing_runs_customer
  ON wb_billing_runs (customer_id, created_at DESC);

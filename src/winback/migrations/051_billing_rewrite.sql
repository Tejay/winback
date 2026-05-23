-- Billing rewrite — flat tiered pricing
--
-- Single migration encapsulating the full billing-model rewrite:
--   (a) NEW tables: wb_mrr_snapshots, wb_fx_rates.
--   (b) NEW columns on wb_customers: recommended_tier, billed_tier,
--       smoothed_mrr_usd_minor, smoothed_mrr_computed_at, requires_sales,
--       recommended_changed_at, billed_changed_at.
--   (c) DROPPED columns on wb_recoveries: all perf_fee_* and
--       applied_promotion_code_id. The performance-fee subsystem is being
--       deleted entirely (no per-recovery charges in the new model). This
--       is greenfield-safe — no live paying customers, so no data loss.
--
-- See: /Users/tejay/.claude/plans/we-are-going-to-memoized-kernighan.md

-- (a) NEW TABLES --------------------------------------------------------

CREATE TABLE IF NOT EXISTS wb_mrr_snapshots (
  id                              BIGSERIAL PRIMARY KEY,
  customer_id                     UUID NOT NULL
    REFERENCES wb_customers(id) ON DELETE CASCADE,
  mrr_usd_minor                   BIGINT NOT NULL,
  per_currency                    JSONB NOT NULL,
  breakdown                       JSONB NOT NULL,
  stripe_reported_mrr_usd_minor   BIGINT,
  source                          TEXT NOT NULL
    CHECK (source IN ('weekly_cron', 'webhook', 'activation_live_read')),
  taken_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mrr_snapshots_customer_taken_at
  ON wb_mrr_snapshots (customer_id, taken_at DESC);

COMMENT ON TABLE wb_mrr_snapshots IS
  'Per-customer MRR snapshots — written by the weekly cron, webhook recompute on subscription changes, and live reads at first activation. Smoothed MRR is the median over the trailing 30-day window of available snapshots.';

COMMENT ON COLUMN wb_mrr_snapshots.mrr_usd_minor IS
  'Our computed MRR total in USD cents — sum of normalized subscription items across all currencies.';

COMMENT ON COLUMN wb_mrr_snapshots.per_currency IS
  'JSON map of currency code → MRR contribution in native minor units. Useful for the activation breakdown UI.';

COMMENT ON COLUMN wb_mrr_snapshots.breakdown IS
  'JSON object with subscription counts per status (active, past_due, excluded_trialing, excluded_canceled) for the transparency block.';

COMMENT ON COLUMN wb_mrr_snapshots.stripe_reported_mrr_usd_minor IS
  'Stripe Analytics API revenue.mrr figure for second-opinion reconciliation. NULL when the API was unavailable or Connect-incompatible at snapshot time.';

CREATE TABLE IF NOT EXISTS wb_fx_rates (
  currency     TEXT PRIMARY KEY,
  rate_usd     NUMERIC(18, 8) NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE wb_fx_rates IS
  'Daily FX rates from the chosen provider. Used by mrr.ts to convert non-USD subscription amounts to USD. USD itself is short-circuited and never stored.';

-- (b) NEW COLUMNS ON wb_customers ---------------------------------------

ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS recommended_tier         TEXT,
  ADD COLUMN IF NOT EXISTS billed_tier              TEXT,
  ADD COLUMN IF NOT EXISTS smoothed_mrr_usd_minor   BIGINT,
  ADD COLUMN IF NOT EXISTS smoothed_mrr_computed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requires_sales           BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recommended_changed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS billed_changed_at        TIMESTAMPTZ;

COMMENT ON COLUMN wb_customers.recommended_tier IS
  'System-computed tier from smoothed MRR (starter/growth/scale/enterprise/custom). Drives prompts but NEVER auto-charges.';

COMMENT ON COLUMN wb_customers.billed_tier IS
  'Tier the customer is actually subscribed to and paying. Changes only on explicit customer action (activation or portal upgrade/downgrade).';

COMMENT ON COLUMN wb_customers.smoothed_mrr_usd_minor IS
  'Trailing 30-day median of MRR snapshots. Used for mid-life tier transitions. At first activation, the live read overrides this.';

COMMENT ON COLUMN wb_customers.requires_sales IS
  'Set true when recommended_tier = enterprise. Disables self-serve checkout and surfaces a "contact sales" state.';

COMMENT ON COLUMN wb_customers.recommended_changed_at IS
  'Timestamp of the most recent change to recommended_tier. Drives the upgrade/downgrade sustain-window check (now - this >= 14d for upgrade prompt).';

COMMENT ON COLUMN wb_customers.billed_changed_at IS
  'Timestamp of the most recent change to billed_tier.';

-- (c) DROP perf-fee columns from wb_recoveries -------------------------

ALTER TABLE wb_recoveries
  DROP COLUMN IF EXISTS perf_fee_charged_at,
  DROP COLUMN IF EXISTS perf_fee_refunded_at,
  DROP COLUMN IF EXISTS perf_fee_stripe_item_id,
  DROP COLUMN IF EXISTS perf_fee_amount_cents,
  DROP COLUMN IF EXISTS perf_fee_creating_at,
  DROP COLUMN IF EXISTS perf_fee_basis_invoice_id,
  DROP COLUMN IF EXISTS applied_promotion_code_id;

-- Spec 78 — Stripe-native promotions + deferred performance-fee model
--
-- Two related changes ride together because both touch wb_recoveries and
-- both are pre-requisites of the promotion flow:
--
-- 1. wb_improvements gains a 'kind' discriminator so Stripe-synced
--    promotion codes can live alongside merchant-authored product
--    improvements without a separate table.
--
-- 2. wb_customers gains a promotions_enabled opt-in flag (default false)
--    that gates the promo-aware email path. Off by default preserves
--    Winback's "we don't recover by discounting" positioning.
--
-- 3. wb_recoveries gains applied_promotion_code_id (which promo this
--    recovery used, if any) and perf_fee_basis_invoice_id (which
--    Connect-side invoice's amount_paid set the perf-fee basis; also
--    serves as the idempotency key for the new invoice.payment_succeeded
--    handler that fires the fee).
--
-- The perf-fee model shift (fire on first-paid-invoice instead of at
-- activation) reuses the existing perf_fee_amount_cents column for "what
-- we actually charged" — no new column.

ALTER TABLE wb_improvements
  ADD COLUMN kind text NOT NULL DEFAULT 'product'
    CHECK (kind IN ('product', 'promotion'));

ALTER TABLE wb_improvements
  ADD COLUMN promotion_metadata jsonb;

COMMENT ON COLUMN wb_improvements.kind IS
  'Spec 78 — discriminates merchant-authored product improvements (default) from Stripe-synced promotion codes.';

COMMENT ON COLUMN wb_improvements.promotion_metadata IS
  'Spec 78 — Stripe coupon + promotion-code snapshot (see WbPromotionMetadata Zod schema). NULL for kind=product rows.';

ALTER TABLE wb_customers
  ADD COLUMN promotions_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN wb_customers.promotions_enabled IS
  'Spec 78 — gates the promo-aware win-back path. Default false preserves the "we don''t recover by discounting" positioning.';

ALTER TABLE wb_recoveries
  ADD COLUMN applied_promotion_code_id text;

ALTER TABLE wb_recoveries
  ADD COLUMN perf_fee_basis_invoice_id text;

COMMENT ON COLUMN wb_recoveries.applied_promotion_code_id IS
  'Spec 78 — Stripe promotion_code id attached to the reactivated subscription, when the recovery was promo-driven.';

COMMENT ON COLUMN wb_recoveries.perf_fee_basis_invoice_id IS
  'Spec 78 — Connect-side Stripe invoice id whose amount_paid set the perf-fee basis. Also serves as idempotency key for the invoice.payment_succeeded handler that fires the fee.';

-- Per-account, per-subscription lookup: the new invoice.payment_succeeded
-- handler reads (newStripeSubId) to map an incoming invoice to its
-- recovery row. Without this index the lookup scans wb_recoveries on
-- every Connect-side invoice event.
CREATE INDEX IF NOT EXISTS idx_wb_recoveries_new_stripe_sub_id
  ON wb_recoveries (new_stripe_sub_id);

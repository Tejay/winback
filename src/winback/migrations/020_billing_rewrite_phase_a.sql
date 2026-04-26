-- Phase A — Billing engine rewrite (additive only).
--
-- Adds columns required for the new pricing model:
--   • Platform fee = $99/mo Stripe Subscription (recurring)
--   • Performance fee = 1× MRR per voluntary-cancellation win-back,
--     charged once, refundable for 14 days if the subscriber re-cancels
--
-- This migration is purely additive. Old columns and tables remain so the
-- existing 15% × 12-month engine continues to run untouched. Phase B wires
-- the new engine into webhooks and replaces the cron. Phase C drops the
-- old columns and tables.

ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

ALTER TABLE wb_recoveries
  ADD COLUMN IF NOT EXISTS recovery_type text,            -- 'win_back' | 'card_save'
  ADD COLUMN IF NOT EXISTS perf_fee_charged_at timestamptz,
  ADD COLUMN IF NOT EXISTS perf_fee_refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS perf_fee_stripe_item_id text,
  ADD COLUMN IF NOT EXISTS perf_fee_amount_cents integer;

CREATE INDEX IF NOT EXISTS idx_wb_customers_stripe_subscription
  ON wb_customers (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

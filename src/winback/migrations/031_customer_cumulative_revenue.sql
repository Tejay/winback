-- Spec 41 — Cached cumulative revenue saved per customer.
--
-- The dashboard's "MRR recovered" card today sums plan_mrr_cents per
-- recovery — i.e. the monthly subscription value at the moment of
-- recovery. A recovered customer who stays 18 months actually returned
-- 18× that MRR in real revenue; the card credits 1×. Computing the true
-- lifetime number on every dashboard load would walk every recovery +
-- check for re-churn — fine at small scale, slow at large scale.
--
-- This migration adds a cached column that the daily cron writes; the
-- dashboard reads one indexed value (already keyed by user_id via the
-- customer row lookup). No additional index needed.
--
-- BIGINT chosen because mrr_cents × months_retained can exceed INT4 at
-- enterprise volumes (e.g. $5k/mo × 60mo × 1000 customers = $300M cents
-- = 3e10, which fits in BIGINT but not INT4).

ALTER TABLE wb_customers
  ADD COLUMN cumulative_revenue_saved_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN cumulative_revenue_last_computed_at TIMESTAMPTZ;

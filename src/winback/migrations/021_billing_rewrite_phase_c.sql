-- Phase C — Drop the old 15% × 12-month engine schema.
--
-- All code that references these columns/tables has been deleted in this PR.
-- After this migration runs, the only remaining billing surface is the new
-- $99/mo Stripe Subscription + 1× MRR per win-back model implemented in
-- Phase A/B (subscription.ts, performance-fee.ts, activation.ts).
--
-- Pre-launch: no live customers, no in-flight obligations to migrate.

-- 1. Settlement gating — replaced by "cancel subscription, then delete"
ALTER TABLE wb_customers DROP COLUMN IF EXISTS settlement_paid_at;
DROP TABLE IF EXISTS wb_settlement_requests;

-- 2. Old 12-month attribution window — performance fee is now charged
--    once at recovery time, refundable for 14 days. No long-tail.
ALTER TABLE wb_recoveries DROP COLUMN IF EXISTS attribution_ends_at;

-- 3. Old monthly cron audit table — Stripe Subscriptions are now the
--    source of truth for invoice state.
DROP TABLE IF EXISTS wb_billing_runs;

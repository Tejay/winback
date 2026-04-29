-- Spec 34 — capture the latest decline_code from invoice.payment_failed
-- so dunning email copy can be specific to the failure reason.
--
-- Stored as a single text column (not JSONB) — we only need the code
-- itself to drive copy rendering. The full last_payment_error object
-- is available in Stripe's invoice and we can re-fetch if richer
-- diagnostics are ever needed.
--
-- Always overwritten with the LATEST decline_code on every retry: a
-- bank may return different reasons across attempts (e.g. attempt 1
-- = insufficient_funds, attempt 2 = do_not_honor a week later because
-- the customer's bank flagged the merchant). We always copy from the
-- most recent invoice. T2 / T3 emails read the column at send time so
-- they always reflect the latest known reason.
--
-- No backfill — existing rows just carry NULL, which the copy renderer
-- treats as the fallback bucket (today's generic copy).

ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS last_decline_code TEXT;

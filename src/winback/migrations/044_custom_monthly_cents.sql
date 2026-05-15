-- Spec 77 — Per-customer custom flat-rate billing.
--
-- Adds a nullable integer column for the custom monthly fee in cents.
-- NULL = standard billing ($99/mo platform sub + 1× MRR perf fees).
-- Non-NULL = negotiated flat rate (perf fees disabled, platform sub
-- uses a one-off Stripe Price at this amount).
--
-- Mirrors the existing pilot bypass pattern (wb_customers.pilot_until)
-- — a single column on customers that gates the standard billing flow.

ALTER TABLE wb_customers
  ADD COLUMN custom_monthly_cents INTEGER;

COMMENT ON COLUMN wb_customers.custom_monthly_cents IS
  'Spec 77 — Custom flat-rate monthly fee in cents. NULL = standard $99/mo + perf fees. Non-NULL = flat rate (perf fees disabled, platform sub uses a one-off Stripe Price at this amount).';

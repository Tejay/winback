-- Spec 55 — Split pause control: win-back vs payment recovery.
--
-- The existing wb_customers.paused_at is now semantically "win-back only"
-- (we keep the column name to avoid a larger rename). Add a sibling
-- column for the payment-recovery cohort so the two pause toggles in
-- Settings can be controlled independently.
--
-- Each subscriber-facing email send in src/winback/lib/email.ts gates
-- on its cohort's pause column. See spec 55 for the full mapping.

ALTER TABLE wb_customers
ADD COLUMN IF NOT EXISTS paused_dunning_at TIMESTAMP;

COMMENT ON COLUMN wb_customers.paused_at IS
  'Spec 55 — win-back send pause toggle (Settings danger zone). NULL = sending live, timestamp = paused.';

COMMENT ON COLUMN wb_customers.paused_dunning_at IS
  'Spec 55 — payment-recovery send pause toggle (Settings danger zone). NULL = sending live, timestamp = paused.';

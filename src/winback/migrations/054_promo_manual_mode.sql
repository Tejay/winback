-- Spec 80 — Promo codes: manual-default mode (drawer + bulk).
--
-- Introduces the auto-mode toggle and the manual-send audit columns.
-- Additive only — every change is a new column or a backfill of an
-- existing column to its prior-behavior default. Safe to run hot.
--
-- See specs/80-promo-codes-manual-mode.md for the full design.

-- (1) New per-customer toggle: defaults to FALSE for fresh accounts
-- (manual is the new default). The backfill below preserves behavior
-- for any merchant currently using the automatic matcher.
ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS promo_auto_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Preserve behavior for existing merchants currently on automatic
-- promo. Anyone with promotions_enabled = TRUE today is opted into
-- auto mode so the matcher keeps firing without merchant action.
-- New merchants stay on the default (FALSE → manual).
UPDATE wb_customers
   SET promo_auto_mode_enabled = TRUE
 WHERE promotions_enabled = TRUE;

-- (2) Audit trail columns on wb_emails_sent so we can distinguish
-- matcher-fired sends ('automatic') from merchant-clicked sends
-- ('manual'), and record which user pressed the button for manual
-- sends. ON DELETE SET NULL on the FK so user deletion doesn't
-- cascade-wipe email history.
ALTER TABLE wb_emails_sent
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS sent_by_user_id UUID
    REFERENCES wb_users(id) ON DELETE SET NULL;

-- Every existing row predates manual sends, so it's 'automatic'.
UPDATE wb_emails_sent
   SET source = 'automatic'
 WHERE source IS NULL;

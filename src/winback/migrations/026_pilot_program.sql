-- Spec 31 — Pilot program (free 30-day trial for up to 10 founders).
--
-- Adds two timestamp columns on wb_customers and a new wb_pilot_tokens
-- table. The bypass gates in activation + performance-fee paths read
-- wb_customers.pilot_until to decide whether to skip platform billing
-- and per-recovery performance fees. Token model mirrors Spec 29
-- password-reset: sha256-hashed-in-DB, single-use, time-bounded.

ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS pilot_until                  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS pilot_ending_warned_at       TIMESTAMP;

CREATE TABLE IF NOT EXISTS wb_pilot_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         text NOT NULL UNIQUE,
  expires_at         timestamp NOT NULL,
  used_at            timestamp,
  used_by_user_id    uuid REFERENCES wb_users(id) ON DELETE SET NULL,
  note               text,
  created_at         timestamp NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES wb_users(id) ON DELETE SET NULL
);

-- Active-pilot lookups: 10-slot cap, admin UI list, isCustomerOnPilot gate.
CREATE INDEX IF NOT EXISTS wb_customers_pilot_until_idx
  ON wb_customers (pilot_until)
  WHERE pilot_until IS NOT NULL;

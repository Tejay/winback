-- Spec 32 — Email verification.
--
-- Adds wb_users.email_verified_at and a verification-token table mirroring
-- Spec 29 password-reset. Backfill sets every existing row as verified —
-- the 4 active pilots + admin + support + any test accounts were all
-- manually onboarded by the operator and are trusted.

ALTER TABLE wb_users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;

UPDATE wb_users
SET    email_verified_at = now()
WHERE  email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS wb_email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES wb_users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamp NOT NULL,
  used_at     timestamp,
  created_at  timestamp NOT NULL DEFAULT now(),
  ip_address  text
);

-- Active-token lookup per user (invalidate-prior-on-resend).
CREATE INDEX IF NOT EXISTS idx_email_verif_user_active
  ON wb_email_verification_tokens (user_id, created_at DESC)
  WHERE used_at IS NULL;

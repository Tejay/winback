-- Spec 29 — Password reset tokens.
--
-- Single-use, time-limited tokens for the /forgot-password → /reset-password
-- flow. The raw token only ever lives in the email link; the DB stores a
-- sha256 hash so a DB compromise alone cannot mint a valid reset link.
--
-- Lookups always check `used_at IS NULL AND expires_at > now()`.
-- A new request for the same user invalidates prior unused tokens.

CREATE TABLE IF NOT EXISTS wb_password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES wb_users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamp NOT NULL,
  used_at     timestamp,
  created_at  timestamp NOT NULL DEFAULT now(),
  ip_address  text
);

-- Active-token lookup per user (for invalidate-prior-on-new-request).
CREATE INDEX IF NOT EXISTS idx_pwreset_user_active
  ON wb_password_reset_tokens (user_id, created_at DESC)
  WHERE used_at IS NULL;

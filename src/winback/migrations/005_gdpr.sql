-- Spec 11 Tier 1 — GDPR minimum legal surface
-- Adds per-subscriber opt-out flag and legal acceptance log.

ALTER TABLE wb_churned_subscribers
  ADD COLUMN do_not_contact  boolean     NOT NULL DEFAULT false,
  ADD COLUMN unsubscribed_at timestamptz;

CREATE TABLE wb_legal_acceptances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES wb_users(id) ON DELETE CASCADE,
  version      text NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  ip_address   text
);

CREATE INDEX idx_legal_acceptances_user ON wb_legal_acceptances(user_id);

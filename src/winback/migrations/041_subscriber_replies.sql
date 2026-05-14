-- Spec 71 — append-only inbound reply history.
--
-- The pre-existing `wb_churned_subscribers.reply_text` column overwrote
-- on each new reply, losing the body of every prior turn. This migration
-- replaces it with a per-row table so we can keep the full conversation
-- and feed it to the classifier as a chronological thread.
--
-- Pre-launch: no rollback path for the dropped column's existing data
-- (dev rows only, intentional loss).

CREATE TABLE wb_subscriber_replies (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id         UUID NOT NULL REFERENCES wb_churned_subscribers(id) ON DELETE CASCADE,
  body                  TEXT NOT NULL CHECK (length(body) <= 20480),
  from_email            TEXT,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Resend's inbound email_id; UNIQUE = second line of defense against
  -- double-insert (Spec 64's wb_inbound_events is the first).
  resend_email_id       TEXT UNIQUE,
  -- The outbound this reply was a response to. NULL when threading
  -- couldn't be resolved (no In-Reply-To header, or no match).
  in_reply_to_email_id  UUID REFERENCES wb_emails_sent(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wb_subscriber_replies_subscriber_received
  ON wb_subscriber_replies (subscriber_id, received_at DESC);

ALTER TABLE wb_churned_subscribers DROP COLUMN reply_text;

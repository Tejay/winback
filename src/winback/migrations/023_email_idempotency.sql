-- Spec 28 — Email-level idempotency.
--
-- At-most-once delivery for the auto-send email types. The webhook's
-- find-or-resend logic (Spec 28 Part B) re-runs the send when an existing
-- subscriber row has no corresponding emails_sent row; this index is the
-- DB-level safety net that ensures even a race past that check still
-- results in exactly one send per (subscriber, type).
--
-- Partial: 'founder_handoff' and other manual types are intentionally
-- multi-send, so we restrict to the auto-send set.

CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_sent_unique
  ON wb_emails_sent (subscriber_id, type)
  WHERE type IN ('exit', 'dunning', 'win_back');

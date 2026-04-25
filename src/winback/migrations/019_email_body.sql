-- Spec 27 — Subscriber Inspector requires the email body to render the
-- conversation turn-by-turn. Currently we save subject + Resend message id,
-- but the body itself is generated, sent via Resend, then forgotten. For
-- follow-ups especially the body is AI-generated per re-classification —
-- not reconstructable from any other source.
--
-- Backfill: historical rows get NULL. The Inspector renders
-- "(body not preserved — sent before instrumentation)" for those.

ALTER TABLE wb_emails_sent
  ADD COLUMN IF NOT EXISTS body_text text;

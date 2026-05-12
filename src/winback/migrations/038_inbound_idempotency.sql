-- Spec 64 — Inbound webhook idempotency.
--
-- Resend's `email.received` webhook has no replay protection today. A
-- retry (network blip, our 500, transient Vercel error) re-processes the
-- same `email_id`: re-runs the classifier (~$0.003 LLM cost) and may send
-- a duplicate auto-reply to the subscriber.
--
-- This table is the dedup ledger: every inbound notification ID we've
-- accepted is inserted at the top of the handler with `outcome='reserved'`,
-- then updated to a terminal outcome (processed / no_subscriber_id /
-- empty_reply_text / subscriber_not_found) at each exit. A second webhook
-- with the same email_id conflicts on the PRIMARY KEY and short-circuits
-- before any DB write or classifier call.
--
-- Pattern follows Stripe's Idempotency-Key approach: store the token,
-- short-circuit on conflict, accept at-most-once semantics. A crash
-- between the reservation and the terminal update rejects the retry —
-- the reply surfaces as `outcome='reserved'` in /admin for manual triage.

CREATE TABLE IF NOT EXISTS wb_inbound_events (
  email_id      TEXT PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'resend_inbound',
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  subscriber_id UUID NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN (
                  'reserved',
                  'processed',
                  'no_subscriber_id',
                  'subscriber_not_found',
                  'empty_reply_text'
                ))
);

CREATE INDEX IF NOT EXISTS idx_wb_inbound_events_received_at
  ON wb_inbound_events (received_at DESC);

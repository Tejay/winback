-- Minimal first-party events table. First use: Stripe-connect onboarding
-- conversion funnel (onboarding_stripe_viewed, connect_clicked,
-- oauth_redirect, oauth_completed, oauth_denied, oauth_error). Keeps
-- telemetry first-party so we don't need PostHog/Plausible for this page.
-- See /Users/tejay/.claude/plans/zesty-beaming-panda.md for the design.

CREATE TABLE wb_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES wb_customers(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES wb_users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  properties  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Funnel queries: "how many X events in the last day?"
CREATE INDEX wb_events_name_created_idx
  ON wb_events (name, created_at DESC);

-- Per-customer timeline: "what did this user do on this page?"
CREATE INDEX wb_events_customer_created_idx
  ON wb_events (customer_id, created_at DESC);

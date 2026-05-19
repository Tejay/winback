-- Drawer insight (replaces handoff_reasoning as the founder-facing AI
-- commentary shown above the conversation in the dashboard drawer).
--
-- Background: the old model had the classifier decide on every pass
-- whether to hand a subscriber off to the founder (binary handoff +
-- handoff_reasoning paragraph). The new model removes the automatic
-- handoff entirely — AI keeps running on every subscriber, the founder
-- takes over manually via a UI toggle when they choose to. The
-- drawer needs a purely descriptive AI summary instead.
--
-- Schema: two short text fields, both populated on every classification
-- pass. NOT NULL with empty-string defaults so rows pre-dating the
-- column-add still render in the UI without null-guards everywhere.
--
--   drawer_insight_read          — what's happening (~100 chars, 1 sentence)
--   drawer_insight_worth_knowing — specific detail to highlight (~100 chars,
--                                  may be empty when nothing distinctive)
--
-- handoff_reasoning / recovery_likelihood stay on the table during the
-- transition. recovery_likelihood is still in use (drives the table flag).
-- handoff_reasoning is dead weight and will be dropped in a later
-- migration once all reader code is cleaned up.

ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS drawer_insight_read          text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS drawer_insight_worth_knowing text NOT NULL DEFAULT '';

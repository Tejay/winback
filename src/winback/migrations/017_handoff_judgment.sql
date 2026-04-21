-- AI-decided founder hand-off (plan: how-can-we-ensure-tender-bengio).
--
-- Replaces the count-based MAX_FOLLOWUPS hand-off with a classifier-emitted
-- decision. We persist the AI's per-pass reasoning and its recovery estimate
-- so founders can audit judgment and so we can spot-check whether the model
-- is escalating the right cases.
--
-- Both columns are overwritten on every classification pass (initial churn +
-- every subsequent reply). Historical per-pass values live in wb_events via
-- logEvent.

ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS handoff_reasoning   text,
  ADD COLUMN IF NOT EXISTS recovery_likelihood text;

-- recovery_likelihood is 'high' | 'medium' | 'low' (application-enforced,
-- not a DB check — keeps the enum editable without a migration).

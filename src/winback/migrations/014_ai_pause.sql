-- Spec 22a — Per-subscriber AI pause
-- Generalizes the spec 21 handoff-snooze into a broader pause that works on
-- any subscriber. The rename preserves all existing snooze values.

-- Rename: founder_handoff_snoozed_until → ai_paused_until
ALTER TABLE wb_churned_subscribers
  RENAME COLUMN founder_handoff_snoozed_until TO ai_paused_until;

-- Track when the pause started (used for the 30-day strong-attribution window)
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMPTZ;

-- Free-text audit: 'handoff' | 'founder_handling' | 'maybe_later' | 'personal' | etc.
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS ai_paused_reason TEXT;

-- Backfill ai_paused_at for existing snoozes (all are handoff-related).
-- Approximate start time using updated_at — better than null.
UPDATE wb_churned_subscribers
  SET ai_paused_at = updated_at,
      ai_paused_reason = 'handoff'
  WHERE ai_paused_until IS NOT NULL
    AND ai_paused_at IS NULL;

-- Spec 19b — Replace short trigger_keyword with rich trigger_need description.
-- The old trigger_keyword existed because ILIKE substring matching needed short literal text.
-- LLM re-rank (spec 19a) doesn't need that — a 1-2 sentence natural-language description
-- of what the subscriber actually wants gives the matcher more signal.

ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS trigger_need TEXT;

-- Backfill: existing subscribers' trigger_keyword copies into trigger_need so the
-- new matcher has something to work with for already-churned subscribers.
-- New cancellations will populate trigger_need with rich descriptions directly.
UPDATE wb_churned_subscribers
  SET trigger_need = trigger_keyword
  WHERE trigger_need IS NULL AND trigger_keyword IS NOT NULL;

-- Keep trigger_keyword column for now (don't drop) — backwards compatibility during
-- the transition. A later migration can remove it once we're confident.

-- Index on trigger_need for the candidate query (mirrors the existing trigger_keyword index).
CREATE INDEX IF NOT EXISTS idx_churned_trigger_need
  ON wb_churned_subscribers(trigger_need)
  WHERE trigger_need IS NOT NULL;

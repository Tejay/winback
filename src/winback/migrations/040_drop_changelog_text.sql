-- Spec 65 — drop the now-unused free-text changelog blob. Replaced by
-- per-entry rows in wb_improvements (added in migration 039). All callers
-- and tests have been updated; this column is referenced by nothing.
ALTER TABLE wb_customers DROP COLUMN IF EXISTS changelog_text;

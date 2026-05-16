-- Spec 79 — AI-clustered cancellation themes.
--
-- A weekly cron pulls each customer's UNMATCHED cancellations (those
-- not caught by an existing improvement's matcher) and asks an LLM to
-- cluster them by theme. The result lands here and powers the "What
-- your cancelled customers asked for" card on /reasons.
--
-- One row per theme. The clusterer wipes the customer's prior rows
-- and inserts fresh on every run (simple snapshot model — no diffing,
-- no theme-id stability across runs).
--
-- Two row "types" share the same shape:
--   • addresses_improvement_id IS NULL — primary theme: "3+ customers
--     cite this problem and you haven't addressed it". Rendered as a
--     row in the main themes card.
--   • addresses_improvement_id IS NOT NULL — post-ship insight: "you
--     shipped this improvement, but 3+ customers cancelled afterwards
--     still citing the same problem". Rendered as the indigo "💡 Insight"
--     strip above the themes card.

CREATE TABLE wb_cancellation_themes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id              uuid NOT NULL REFERENCES wb_customers(id) ON DELETE CASCADE,
  -- NULL = primary theme; set = post-ship insight referencing that improvement.
  addresses_improvement_id uuid REFERENCES wb_improvements(id) ON DELETE CASCADE,
  title                    text NOT NULL,
  description              text NOT NULL,
  category                 text,             -- 'Price' | 'Feature' | 'Other' (LLM best-effort)
  emoji                    text,             -- 🔥 / 📊 / 🌱 / 💡 (LLM picks)
  customer_count           integer NOT NULL,
  subscriber_ids           uuid[] NOT NULL,
  sample_quotes            text[] NOT NULL,
  window_start             timestamptz NOT NULL,
  window_end               timestamptz NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wb_cancellation_themes_customer_created
  ON wb_cancellation_themes (customer_id, created_at DESC);

COMMENT ON TABLE wb_cancellation_themes IS
  'Spec 79 — weekly LLM clusters of unmatched cancellations. Wiped + reinserted per customer per cron run.';

COMMENT ON COLUMN wb_cancellation_themes.addresses_improvement_id IS
  'NULL = primary theme (gap in current reasons). Set = post-ship insight (shipped improvement but customers still cite the problem).';

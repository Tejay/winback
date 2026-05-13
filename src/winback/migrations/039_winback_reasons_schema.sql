-- Spec 65 Phase 1 — Winback Reasons schema.
--
-- Additive only. No existing columns dropped or modified. Safe to roll
-- back by dropping the new tables and columns.
--
-- Two new tables:
--   wb_improvements         — per-entry merchant improvements (replaces
--                             the free-text `customers.changelog_text` blob)
--   wb_improvement_matches  — tracks which improvement matched which
--                             subscriber, enforces "each customer hears
--                             about an improvement at most once"
--
-- Three new columns on wb_churned_subscribers:
--   trigger_need_confidence — classifier confidence bucket ('high'|'low')
--   last_reengaged_at        — cooldown timestamp scoped to
--                              changelog-triggered emails only
--   reengagement_expired_at  — set when subscriber hits the 9-month wall
--
-- One new column on wb_emails_sent:
--   improvement_id           — links re-engagement emails to the
--                              improvement that triggered them
--
-- `customers.changelog_text` is NOT dropped. It stays as a sunset
-- column until Phase 2 migrates existing content into wb_improvements.


-- =========================================================================
-- wb_improvements
-- =========================================================================
CREATE TABLE IF NOT EXISTS wb_improvements (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       UUID NOT NULL REFERENCES wb_customers(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  date_shipped      DATE NOT NULL,
  status            TEXT NOT NULL DEFAULT 'published',
  addresses_pattern TEXT NULL,
  preempted         BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at       TIMESTAMPTZ NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Bounds enforced at the DB layer as a final guard. The API does the
  -- same checks with friendlier error messages, but if anything else
  -- writes here, the DB still refuses junk.
  CONSTRAINT wb_improvements_title_length CHECK (length(title) BETWEEN 4 AND 120),
  CONSTRAINT wb_improvements_description_length CHECK (length(description) BETWEEN 1 AND 500),
  CONSTRAINT wb_improvements_status_check CHECK (status IN ('published', 'archived')),
  CONSTRAINT wb_improvements_date_not_future CHECK (date_shipped <= CURRENT_DATE)
);

CREATE INDEX IF NOT EXISTS idx_wb_improvements_customer_status
  ON wb_improvements (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_wb_improvements_date_shipped
  ON wb_improvements (customer_id, date_shipped DESC);


-- =========================================================================
-- wb_improvement_matches
-- =========================================================================
CREATE TABLE IF NOT EXISTS wb_improvement_matches (
  improvement_id UUID NOT NULL REFERENCES wb_improvements(id) ON DELETE CASCADE,
  subscriber_id  UUID NOT NULL REFERENCES wb_churned_subscribers(id) ON DELETE CASCADE,
  matched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed_at     TIMESTAMPTZ NULL,
  PRIMARY KEY (improvement_id, subscriber_id)
);

CREATE INDEX IF NOT EXISTS idx_wb_improvement_matches_subscriber
  ON wb_improvement_matches (subscriber_id);


-- =========================================================================
-- wb_churned_subscribers — additive columns
-- =========================================================================
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS trigger_need_confidence TEXT
    CHECK (trigger_need_confidence IN ('high', 'low'));

ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS last_reengaged_at TIMESTAMPTZ NULL;

ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS reengagement_expired_at TIMESTAMPTZ NULL;


-- =========================================================================
-- wb_emails_sent — additive column
-- =========================================================================
ALTER TABLE wb_emails_sent
  ADD COLUMN IF NOT EXISTS improvement_id UUID NULL REFERENCES wb_improvements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wb_emails_sent_improvement
  ON wb_emails_sent (improvement_id) WHERE improvement_id IS NOT NULL;

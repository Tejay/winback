-- Feature requests — in-product feedback intake.
--
-- Replaces the now-defunct "Notifications email" field on Settings
-- (its only purpose was routing handoff alerts, and handoffs are
-- removed product-wide). The wb_customers.notification_email column
-- stays in place for now because src/winback/lib/email.ts still reads
-- it as a fallback recipient, pending the wider handoff-code sweep.
-- Only the UI surface is gone.
--
-- New table captures user-submitted feature ideas plus the
-- close-the-loop status fields needed to honour the "we will email
-- you if we ship it" promise made in the form copy. The close-the-loop
-- mechanism itself is deferred until request volume justifies it.

CREATE TABLE IF NOT EXISTS wb_feature_requests (
  id                  BIGSERIAL PRIMARY KEY,
  customer_id         UUID NOT NULL
    REFERENCES wb_customers(id) ON DELETE CASCADE,
  submitted_by_email  TEXT NOT NULL,
  body                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'considering', 'shipped', 'wont_do')),
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  shipped_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_feature_requests_customer_submitted_at
  ON wb_feature_requests(customer_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_feature_requests_status_submitted_at
  ON wb_feature_requests(status, submitted_at DESC);

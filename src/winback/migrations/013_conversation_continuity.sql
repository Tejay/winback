-- Spec 21 — Conversation continuity + founder handoff
-- Combines all schema changes for 21a, 21b, 21c into one migration.

-- 21a — engagement tracking + proactive nudge state
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS last_engagement_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proactive_nudge_at  TIMESTAMPTZ;

-- Backfill last_engagement_at from existing data:
-- - Most recent reply timestamp on any of the subscriber's emails, OR
-- - Their billing portal click timestamp
UPDATE wb_churned_subscribers s
   SET last_engagement_at = COALESCE(
     (SELECT MAX(replied_at) FROM wb_emails_sent WHERE subscriber_id = s.id),
     s.billing_portal_clicked_at
   )
 WHERE s.last_engagement_at IS NULL;

-- 21b — founder handoff state
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS founder_handoff_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS founder_handoff_resolved_at  TIMESTAMPTZ;

-- 21c — snooze + notification email
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS founder_handoff_snoozed_until TIMESTAMPTZ;

ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS notification_email TEXT;

-- Indexes for the new query patterns

-- Engaged-but-silent candidate query (21a) needs efficient lookup by
-- last_engagement_at when status is contacted.
CREATE INDEX IF NOT EXISTS idx_churned_engaged_nudge_eligible
  ON wb_churned_subscribers (last_engagement_at)
  WHERE status = 'contacted'
    AND last_engagement_at IS NOT NULL
    AND proactive_nudge_at IS NULL
    AND founder_handoff_at IS NULL
    AND do_not_contact = FALSE;

-- Founder handoff dashboard query (21b/21c) needs efficient lookup
-- of subscribers awaiting action.
CREATE INDEX IF NOT EXISTS idx_churned_handoff_pending
  ON wb_churned_subscribers (customer_id, founder_handoff_at)
  WHERE founder_handoff_at IS NOT NULL
    AND founder_handoff_resolved_at IS NULL;

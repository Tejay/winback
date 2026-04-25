-- Spec 25 — Operational admin dashboard.
--
-- Adds:
--   1. is_admin flag on wb_users so we can gate /admin without hard-coded
--      email checks (the previous test-harness gating pattern).
--   2. A case-insensitive email index on wb_churned_subscribers — drives the
--      cross-customer subscriber lookup in /admin/subscribers, which is the
--      single most-used page during complaint triage.

ALTER TABLE wb_users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Seed the founder so the dev test harness can stop using a hard-coded
-- email check and route through requireAdmin() instead. New admins go via
-- a SQL UPDATE until we build a manage-admins UI in Phase 3.
UPDATE wb_users
SET    is_admin = TRUE
WHERE  email = 'tejaasvi@gmail.com';

-- Cross-customer subscriber lookup. ILIKE on email is fine but case-insensitive
-- exact match is the dominant query pattern (support pastes the email verbatim),
-- so a btree on lower(email) makes that path near-instant.
CREATE INDEX IF NOT EXISTS idx_churned_subscribers_email_ci
  ON wb_churned_subscribers (LOWER(email))
  WHERE email IS NOT NULL;

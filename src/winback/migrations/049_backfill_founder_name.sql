-- One-time backfill: populate customers.founder_name from users.name
-- for any customer rows that have it set to NULL.
--
-- Historical bug: app/api/auth/register/route.ts created the customer
-- row without setting founderName, so signups before commit 048's
-- companion register-fix have founder_name = NULL. The classifier prompt
-- falls through to "The team" in that case → win-back emails sign as
-- "— The team" instead of "— <founder first name>".
--
-- This UPDATE only touches NULL rows (covers existing data without
-- overwriting anything the founder may have explicitly set via the
-- Settings page).

UPDATE wb_customers c
SET founder_name = u.name
FROM wb_users u
WHERE c.user_id = u.id
  AND c.founder_name IS NULL
  AND u.name IS NOT NULL
  AND length(trim(u.name)) > 0;

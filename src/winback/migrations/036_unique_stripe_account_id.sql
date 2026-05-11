-- Spec 56 — One Stripe Connect account links to at most one Winback
-- customer row. Without this, two wb_customers rows could share the
-- same stripe_account_id, and webhook handlers' `.limit(1)` lookups
-- would silently pick the wrong row (multi-tenant data leak).
--
-- Partial index: NULL stripe_account_id values (un-OAuthed customers)
-- are allowed freely; only set-but-duplicate values are rejected.
--
-- BACKFILL ORDERING: this migration FAILS if there are existing
-- duplicates. Run `scripts/spec-56-backfill-duplicates.ts --apply`
-- first to NULL out non-canonical rows, then apply this migration.
CREATE UNIQUE INDEX IF NOT EXISTS customers_stripe_account_id_unique
  ON wb_customers (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;

COMMENT ON INDEX customers_stripe_account_id_unique IS
  'Spec 56 — enforces 1:1 between Connect account and Winback customer. '
  'OAuth callback rejects re-link attempts with friendly UX error. '
  'Backfill any existing duplicates before applying.';

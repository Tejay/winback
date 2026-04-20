-- Spec 23 — Platform billing card capture (Phase 9.1)
-- Adds the Winback-platform Stripe customer ID per wb_customer.
-- This is separate from stripe_account_id (which is the customer's own
-- Connected account used for webhook listening / customer.subscription events).
--
-- Lazy-created: populated on first "Add payment method" click. Most trial
-- customers without recoveries will never have this set.

ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS stripe_platform_customer_id TEXT;

-- No index needed — lookups are always by wb_customers.id (PK) or .user_id (already unique).

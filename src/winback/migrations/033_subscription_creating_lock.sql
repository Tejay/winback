-- Spec 52 — race fence for ensurePlatformSubscription.
--
-- Without this column, two parallel callers (the spec 52 synchronous
-- /billing/success page + the existing checkout.session.completed
-- webhook handler) can both pass the "no subscription exists yet"
-- pre-check and both call stripe.subscriptions.create, producing one
-- orphan subscription that bills the customer with no DB record.
--
-- The column is used as a TTL'd creation lock: ensurePlatformSubscription
-- atomically claims it via a single conditional UPDATE before calling
-- Stripe, and releases it (back to NULL) after writing the resulting
-- subscription_id. A 30s TTL lets a crashed claimer be reclaimed.

ALTER TABLE wb_customers
ADD COLUMN IF NOT EXISTS stripe_subscription_creating_at TIMESTAMP;

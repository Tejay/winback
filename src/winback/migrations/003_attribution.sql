ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE wb_recoveries ADD COLUMN IF NOT EXISTS attribution_type TEXT DEFAULT 'weak';

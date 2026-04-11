ALTER TABLE wb_customers ADD COLUMN IF NOT EXISTS stripe_webhook_secret TEXT;

ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS billing_portal_clicked_at TIMESTAMPTZ;
ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS payment_method_at_failure TEXT;

CREATE TABLE IF NOT EXISTS wb_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wb_customers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL UNIQUE REFERENCES wb_users(id) ON DELETE CASCADE,
  stripe_account_id    TEXT,
  stripe_access_token  TEXT,
  gmail_refresh_token  TEXT,
  gmail_email          TEXT,
  founder_name         TEXT,
  product_name         TEXT,
  changelog_text       TEXT,
  onboarding_complete  BOOLEAN DEFAULT FALSE,
  plan                 TEXT DEFAULT 'trial',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wb_churned_subscribers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES wb_customers(id) ON DELETE CASCADE,
  stripe_customer_id    TEXT NOT NULL,
  email                 TEXT,
  name                  TEXT,
  plan_name             TEXT,
  mrr_cents             INTEGER NOT NULL DEFAULT 0,
  tenure_days           INTEGER,
  ever_upgraded         BOOLEAN DEFAULT FALSE,
  near_renewal          BOOLEAN DEFAULT FALSE,
  payment_failures      INTEGER DEFAULT 0,
  previous_subs         INTEGER DEFAULT 0,
  stripe_enum           TEXT,
  stripe_comment        TEXT,
  reply_text            TEXT,
  cancellation_reason   TEXT,
  cancellation_category TEXT,
  tier                  INTEGER,
  confidence            DECIMAL(3,2),
  trigger_keyword       TEXT,
  win_back_subject      TEXT,
  win_back_body         TEXT,
  status                TEXT DEFAULT 'pending',
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, stripe_customer_id)
);

CREATE TABLE IF NOT EXISTS wb_emails_sent (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id    UUID NOT NULL REFERENCES wb_churned_subscribers(id) ON DELETE CASCADE,
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  type             TEXT NOT NULL,
  subject          TEXT,
  sent_at          TIMESTAMPTZ DEFAULT NOW(),
  replied_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS wb_recoveries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id       UUID NOT NULL REFERENCES wb_churned_subscribers(id),
  customer_id         UUID NOT NULL REFERENCES wb_customers(id),
  recovered_at        TIMESTAMPTZ DEFAULT NOW(),
  plan_mrr_cents      INTEGER NOT NULL,
  new_stripe_sub_id   TEXT,
  attribution_ends_at TIMESTAMPTZ NOT NULL,
  still_active        BOOLEAN DEFAULT TRUE,
  last_checked_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_churned_customer  ON wb_churned_subscribers(customer_id);
CREATE INDEX IF NOT EXISTS idx_churned_status    ON wb_churned_subscribers(status);
CREATE INDEX IF NOT EXISTS idx_churned_keyword   ON wb_churned_subscribers(trigger_keyword) WHERE trigger_keyword IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emails_thread     ON wb_emails_sent(gmail_thread_id)         WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recoveries_active ON wb_recoveries(customer_id)              WHERE still_active = TRUE;

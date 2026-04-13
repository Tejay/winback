import { pgTable, uuid, text, integer, boolean, decimal, timestamp } from 'drizzle-orm/pg-core'

export const users = pgTable('wb_users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name:         text('name'),
  createdAt:    timestamp('created_at').defaultNow(),
})

export const customers = pgTable('wb_customers', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  userId:             uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  stripeAccountId:    text('stripe_account_id'),
  stripeAccessToken:  text('stripe_access_token'),
  gmailRefreshToken:  text('gmail_refresh_token'),
  gmailEmail:         text('gmail_email'),
  founderName:        text('founder_name'),
  productName:        text('product_name'),
  changelogText:      text('changelog_text'),
  onboardingComplete: boolean('onboarding_complete').default(false),
  plan:               text('plan').default('trial'),
  createdAt:          timestamp('created_at').defaultNow(),
  updatedAt:          timestamp('updated_at').defaultNow(),
})

export const churnedSubscribers = pgTable('wb_churned_subscribers', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  customerId:           uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  stripeCustomerId:     text('stripe_customer_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id'),
  stripePriceId:        text('stripe_price_id'),
  email:                text('email'),
  name:                 text('name'),
  planName:             text('plan_name'),
  mrrCents:             integer('mrr_cents').notNull().default(0),
  tenureDays:           integer('tenure_days'),
  everUpgraded:         boolean('ever_upgraded').default(false),
  nearRenewal:          boolean('near_renewal').default(false),
  paymentFailures:      integer('payment_failures').default(0),
  previousSubs:         integer('previous_subs').default(0),
  stripeEnum:           text('stripe_enum'),
  stripeComment:        text('stripe_comment'),
  replyText:            text('reply_text'),
  cancellationReason:   text('cancellation_reason'),
  cancellationCategory: text('cancellation_category'),
  tier:                 integer('tier'),
  confidence:           decimal('confidence', { precision: 3, scale: 2 }),
  triggerKeyword:       text('trigger_keyword'),
  winBackSubject:       text('win_back_subject'),
  winBackBody:          text('win_back_body'),
  status:               text('status').default('pending'),
  billingPortalClickedAt: timestamp('billing_portal_clicked_at'),
  paymentMethodAtFailure: text('payment_method_at_failure'),
  cancelledAt:          timestamp('cancelled_at'),
  createdAt:            timestamp('created_at').defaultNow(),
  updatedAt:            timestamp('updated_at').defaultNow(),
})

export const emailsSent = pgTable('wb_emails_sent', {
  id:             uuid('id').primaryKey().defaultRandom(),
  subscriberId:   uuid('subscriber_id').notNull().references(() => churnedSubscribers.id, { onDelete: 'cascade' }),
  gmailMessageId: text('gmail_message_id'),
  gmailThreadId:  text('gmail_thread_id'),
  type:           text('type').notNull(),
  subject:        text('subject'),
  sentAt:         timestamp('sent_at').defaultNow(),
  repliedAt:      timestamp('replied_at'),
})

export const recoveries = pgTable('wb_recoveries', {
  id:                uuid('id').primaryKey().defaultRandom(),
  subscriberId:      uuid('subscriber_id').notNull().references(() => churnedSubscribers.id),
  customerId:        uuid('customer_id').notNull().references(() => customers.id),
  recoveredAt:       timestamp('recovered_at').defaultNow(),
  planMrrCents:      integer('plan_mrr_cents').notNull(),
  newStripeSubId:    text('new_stripe_sub_id'),
  attributionEndsAt: timestamp('attribution_ends_at').notNull(),
  attributionType:   text('attribution_type').default('weak'),
  stillActive:       boolean('still_active').default(true),
  lastCheckedAt:     timestamp('last_checked_at').defaultNow(),
})

import { pgTable, uuid, text, integer, boolean, decimal, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

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
  notificationEmail:  text('notification_email'),  // Spec 21c — overrides user.email for handoff alerts
  // Spec 23 — Winback's platform Stripe customer (for billing the founder 15% fees).
  // Separate from stripeAccountId (Connected account for webhooks).
  stripePlatformCustomerId: text('stripe_platform_customer_id'),
  pausedAt:             timestamp('paused_at'),
  settlementPaidAt:     timestamp('settlement_paid_at'),
  backfillTotal:        integer('backfill_total').default(0),
  backfillProcessed:    integer('backfill_processed').default(0),
  backfillStartedAt:    timestamp('backfill_started_at'),
  backfillCompletedAt:  timestamp('backfill_completed_at'),
  createdAt:            timestamp('created_at').defaultNow(),
  updatedAt:            timestamp('updated_at').defaultNow(),
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
  triggerKeyword:       text('trigger_keyword'),         // Legacy — kept during transition (spec 19b)
  triggerNeed:          text('trigger_need'),            // Rich 1-2 sentence description used by LLM matcher (spec 19b)
  winBackSubject:       text('win_back_subject'),        // Legacy — generated at churn (deprecated by spec 19c)
  winBackBody:          text('win_back_body'),           // Legacy — generated at churn (deprecated by spec 19c)
  status:               text('status').default('pending'),
  billingPortalClickedAt: timestamp('billing_portal_clicked_at'),
  paymentMethodAtFailure: text('payment_method_at_failure'),
  cancelledAt:          timestamp('cancelled_at'),
  source:               text('source').notNull().default('webhook'),
  doNotContact:         boolean('do_not_contact').notNull().default(false),
  unsubscribedAt:       timestamp('unsubscribed_at'),
  fallbackDays:         integer('fallback_days').default(90),
  reengagementSentAt:   timestamp('reengagement_sent_at'),
  reengagementCount:    integer('reengagement_count').notNull().default(0),
  // Spec 21a — engagement tracking
  lastEngagementAt:     timestamp('last_engagement_at'),
  proactiveNudgeAt:     timestamp('proactive_nudge_at'),
  // Spec 21b — founder handoff
  founderHandoffAt:           timestamp('founder_handoff_at'),
  founderHandoffResolvedAt:   timestamp('founder_handoff_resolved_at'),
  // Spec 22a — AI pause (generalized from the spec 21 handoff snooze).
  //            ai_paused_until replaces the old founder_handoff_snoozed_until column.
  aiPausedUntil:              timestamp('ai_paused_until'),
  aiPausedAt:                 timestamp('ai_paused_at'),
  aiPausedReason:             text('ai_paused_reason'),
  // AI-decided hand-off judgment. Populated on every classification pass —
  // not just when hand-off fires — so the founder (and us) can audit why the
  // AI made its call. Migration 017.
  handoffReasoning:           text('handoff_reasoning'),
  recoveryLikelihood:         text('recovery_likelihood'),   // 'high'|'medium'|'low'
  createdAt:            timestamp('created_at').defaultNow(),
  updatedAt:            timestamp('updated_at').defaultNow(),
})

export const legalAcceptances = pgTable('wb_legal_acceptances', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  version:    text('version').notNull(),
  acceptedAt: timestamp('accepted_at').notNull().defaultNow(),
  ipAddress:  text('ip_address'),
})

export const emailsSent = pgTable('wb_emails_sent', {
  id:             uuid('id').primaryKey().defaultRandom(),
  subscriberId:   uuid('subscriber_id').notNull().references(() => churnedSubscribers.id, { onDelete: 'cascade' }),
  gmailMessageId: text('gmail_message_id'),  // Legacy name — stores Resend message ID
  gmailThreadId:  text('gmail_thread_id'),  // Legacy name — stores reference ID
  type:           text('type').notNull(),
  subject:        text('subject'),
  sentAt:         timestamp('sent_at').defaultNow(),
  repliedAt:      timestamp('replied_at'),
})

export const settlementRequests = pgTable('wb_settlement_requests', {
  id:               uuid('id').primaryKey().defaultRandom(),
  customerId:       uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  obligationCents:  integer('obligation_cents').notNull(),
  liveCount:        integer('live_count').notNull(),
  status:           text('status').notNull().default('pending'), // 'pending' | 'settled' | 'cancelled'
  requestedAt:      timestamp('requested_at').notNull().defaultNow(),
  settledAt:        timestamp('settled_at'),
  stripeSessionId:  text('stripe_session_id'),
  notes:            text('notes'),
})

// Spec 24a — Monthly platform-billing idempotency + audit.
// One row per (customer, month). Insert at cron start; update as the Stripe
// invoice progresses (pending → paid | failed). UNIQUE constraint prevents
// double-billing in a single month.
export const billingRuns = pgTable('wb_billing_runs', {
  id:              uuid('id').primaryKey().defaultRandom(),
  customerId:      uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  periodYyyymm:    text('period_yyyymm').notNull(),       // 'YYYY-MM' — period COVERED, in arrears
  stripeInvoiceId: text('stripe_invoice_id'),
  amountCents:     integer('amount_cents').notNull().default(0),
  status:          text('status').notNull().default('pending'),
  // 'pending' | 'paid' | 'failed' | 'skipped_no_obligations' | 'skipped_no_card'
  lineItemCount:   integer('line_item_count').notNull().default(0),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finalizedAt:     timestamp('finalized_at', { withTimezone: true }),
  paidAt:          timestamp('paid_at', { withTimezone: true }),
})

// First-party events table for conversion funnels. See migration 010 and
// src/winback/lib/events.ts for the logEvent helper. Properties is a free-form
// jsonb blob (error type, stripe account id, etc.) — keep it small.
export const wbEvents = pgTable('wb_events', {
  id:         uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
  userId:     uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  name:       text('name').notNull(),
  properties: jsonb('properties').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  nameCreatedIdx:     index('wb_events_name_created_idx').on(t.name, t.createdAt),
  customerCreatedIdx: index('wb_events_customer_created_idx').on(t.customerId, t.createdAt),
}))

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

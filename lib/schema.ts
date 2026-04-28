import { pgTable, uuid, text, integer, boolean, decimal, timestamp, jsonb, index } from 'drizzle-orm/pg-core'

export const users = pgTable('wb_users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name:         text('name'),
  // Spec 25 — gates /admin and /api/admin/*. Adding admins is a SQL UPDATE
  // until we build a manage-admins UI in Phase 3. Migration 018.
  isAdmin:      boolean('is_admin').notNull().default(false),
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
  // Spec 23 — Winback's platform Stripe customer (for billing the founder).
  // Separate from stripeAccountId (Connected account for webhooks).
  stripePlatformCustomerId: text('stripe_platform_customer_id'),
  // Phase A — $99/mo platform fee Stripe Subscription. Created on first
  // delivered save or win-back via activation.ts. Null until activation.
  stripeSubscriptionId: text('stripe_subscription_id'),
  // Timestamp of first delivered save or win-back — when billing started.
  activatedAt:          timestamp('activated_at'),
  pausedAt:             timestamp('paused_at'),
  backfillTotal:        integer('backfill_total').default(0),
  backfillProcessed:    integer('backfill_processed').default(0),
  backfillStartedAt:    timestamp('backfill_started_at'),
  backfillCompletedAt:  timestamp('backfill_completed_at'),
  // Spec 30 — onboarding-followup cron idempotency timestamps.
  onboardingNudgeSentAt:    timestamp('onboarding_nudge_sent_at'),
  deletionWarningSentAt:    timestamp('deletion_warning_sent_at'),
  // Spec 31 — pilot program. Set on register-with-pilotToken to
  // now() + 30 days. While > now(), platform billing + perf fees are
  // bypassed. After expiry, normal billing flows resume on next event.
  pilotUntil:               timestamp('pilot_until'),
  pilotEndingWarnedAt:      timestamp('pilot_ending_warned_at'),
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
  // Spec 27 — full body text (already-footered) so the subscriber inspector
  // can render the conversation turn-by-turn. Migration 019.
  bodyText:       text('body_text'),
  sentAt:         timestamp('sent_at').defaultNow(),
  repliedAt:      timestamp('replied_at'),
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

// Spec 29 — Password reset tokens. Single-use, 60-min expiry. Stored hashed.
export const passwordResetTokens = pgTable('wb_password_reset_tokens', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash:  text('token_hash').notNull().unique(),
  expiresAt:  timestamp('expires_at').notNull(),
  usedAt:     timestamp('used_at'),
  createdAt:  timestamp('created_at').notNull().defaultNow(),
  ipAddress:  text('ip_address'),
})

// Spec 31 — Pilot program tokens. Single-use, 14-day expiry, sha256-hashed.
// Mirrors password-reset model. Admin issues, founder redeems at /register.
export const pilotTokens = pgTable('wb_pilot_tokens', {
  id:               uuid('id').primaryKey().defaultRandom(),
  tokenHash:        text('token_hash').notNull().unique(),
  expiresAt:        timestamp('expires_at').notNull(),
  usedAt:           timestamp('used_at'),
  usedByUserId:     uuid('used_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  note:             text('note'),
  createdAt:        timestamp('created_at').notNull().defaultNow(),
  createdByUserId:  uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
})

export const recoveries = pgTable('wb_recoveries', {
  id:                uuid('id').primaryKey().defaultRandom(),
  subscriberId:      uuid('subscriber_id').notNull().references(() => churnedSubscribers.id),
  customerId:        uuid('customer_id').notNull().references(() => customers.id),
  recoveredAt:       timestamp('recovered_at').defaultNow(),
  planMrrCents:      integer('plan_mrr_cents').notNull(),
  newStripeSubId:    text('new_stripe_sub_id'),
  // Phase D — removed default 'weak' (every writer sets it explicitly;
  // default never fires).
  attributionType:   text('attribution_type'),
  // recoveryType distinguishes the trigger: 'win_back' (voluntary cancel
  // → reactivation) bills a 1× MRR performance fee; 'card_save' (failed
  // payment recovered) does not bill — the $99/mo platform fee covers it.
  recoveryType:      text('recovery_type'),
  perfFeeChargedAt:  timestamp('perf_fee_charged_at'),
  perfFeeRefundedAt: timestamp('perf_fee_refunded_at'),
  perfFeeStripeItemId: text('perf_fee_stripe_item_id'),
  perfFeeAmountCents: integer('perf_fee_amount_cents'),
})

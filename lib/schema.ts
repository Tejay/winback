import { pgTable, uuid, text, integer, bigint, boolean, decimal, timestamp, date, jsonb, index, uniqueIndex, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const users = pgTable('wb_users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name:         text('name'),
  // Spec 25 — gates /admin and /api/admin/*. Adding admins is a SQL UPDATE
  // until we build a manage-admins UI in Phase 3. Migration 018.
  isAdmin:      boolean('is_admin').notNull().default(false),
  // Spec 32 — null until the founder clicks the verification link in
  // their email. Login refuses unverified accounts (NextAuth authorize
  // throws UnverifiedEmailError). Migration 027.
  emailVerifiedAt: timestamp('email_verified_at'),
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
  onboardingComplete: boolean('onboarding_complete').default(false),
  plan:               text('plan').default('trial'),
  notificationEmail:  text('notification_email'),  // Spec 21c — overrides user.email for handoff alerts
  // Spec 23 — Winback's platform Stripe customer (for billing the founder).
  // Separate from stripeAccountId (Connected account for webhooks).
  stripePlatformCustomerId: text('stripe_platform_customer_id'),
  // Phase A — $99/mo platform fee Stripe Subscription. Created on first
  // delivered save or win-back via activation.ts. Null until activation.
  stripeSubscriptionId: text('stripe_subscription_id'),
  // Spec 52 — TTL'd creation lock. Set by ensurePlatformSubscription's
  // claim step, cleared when the subscription is written. Prevents the
  // synchronous /billing/success path and the checkout.session.completed
  // webhook from both creating subscriptions in parallel.
  stripeSubscriptionCreatingAt: timestamp('stripe_subscription_creating_at'),
  // Timestamp of first delivered save or win-back — when billing started.
  activatedAt:          timestamp('activated_at'),
  // Spec 55 — win-back send pause toggle (Settings danger zone).
  // NULL = sending live, timestamp = paused. The name retains "paused_at"
  // (rather than "paused_winback_at") for backwards compat with existing
  // call sites; semantics narrowed to win-back-only with spec 55.
  pausedAt:             timestamp('paused_at'),
  // Spec 55 — payment-recovery send pause toggle (Settings danger zone).
  // NULL = sending live, timestamp = paused. Independent of pausedAt;
  // gates `sendDunningEmail` + `sendDunningFollowupEmail` only.
  pausedDunningAt:      timestamp('paused_dunning_at'),
  backfillTotal:        integer('backfill_total').default(0),
  backfillProcessed:    integer('backfill_processed').default(0),
  backfillStartedAt:    timestamp('backfill_started_at'),
  backfillCompletedAt:  timestamp('backfill_completed_at'),
  // Spec 72 — pagination cursor (Stripe `starting_after` id) so the
  // cron can resume from where the previous tick left off.
  backfillCursor:       text('backfill_cursor'),
  // Spec 72 — atomic claim lock. NULL = idle. Set at tick entry,
  // cleared at exit. Stale > 10 min is recoverable by the next tick.
  backfillProcessingAt: timestamp('backfill_processing_at', { withTimezone: true }),
  // Spec 30 — onboarding-followup cron idempotency timestamps.
  onboardingNudgeSentAt:    timestamp('onboarding_nudge_sent_at'),
  deletionWarningSentAt:    timestamp('deletion_warning_sent_at'),
  // Spec 31 — pilot program. Set on register-with-pilotToken to
  // now() + 30 days. While > now(), platform billing + perf fees are
  // bypassed. After expiry, normal billing flows resume on next event.
  pilotUntil:               timestamp('pilot_until'),
  pilotEndingWarnedAt:      timestamp('pilot_ending_warned_at'),
  // Per-customer custom flat-rate billing (admin override of the tier
  // ladder). NULL = standard tiered pricing (Starter / Growth / Scale /
  // Enterprise — see billing-config.ts). Non-NULL = negotiated flat
  // monthly fee (tier ladder bypassed; platform sub uses a one-off
  // Stripe Price at this amount). Mirrors the pilot bypass pattern at
  // the column level.
  customMonthlyCents:       integer('custom_monthly_cents'),
  // Spec 78 — opt-in for the promo-aware win-back path. Off by default
  // preserves the "we don't recover by discounting" positioning. Flipped
  // on from /reasons.
  promotionsEnabled:        boolean('promotions_enabled').notNull().default(false),
  // Spec 78 followup — the single promo improvement the merchant has
  // chosen to send. NULL = no promo on outbound emails even when
  // promotionsEnabled is true. Migration 046.
  selectedPromotionImprovementId: uuid('selected_promotion_improvement_id')
    .references((): AnyPgColumn => improvements.id, { onDelete: 'set null' }),
  // Spec 41 — cumulative lifetime revenue saved across all this customer's
  // recoveries. Cached value: written daily by /api/cron/cumulative-revenue
  // and read directly by /api/stats. BIGINT because mrr × months at high
  // volumes exceeds INT4. Default 0 so existing rows are immediately valid;
  // first cron run populates real values.
  cumulativeRevenueSavedCents:      bigint('cumulative_revenue_saved_cents', { mode: 'number' }).notNull().default(0),
  cumulativeRevenueLastComputedAt:  timestamp('cumulative_revenue_last_computed_at'),
  // Spec 51 — billing nudge idempotency + cadence tracking. All four are
  // null until the corresponding event fires; see migration 032.
  billingNudgeDay7SentAt:           timestamp('billing_nudge_day7_sent_at'),
  billingNudgeDay30SentAt:          timestamp('billing_nudge_day30_sent_at'),
  billingMonthlyReportLastSentAt:   timestamp('billing_monthly_report_last_sent_at'),
  billingEmailsOptedOutAt:          timestamp('billing_emails_opted_out_at'),
  // Billing rewrite — tiered pricing state. recommended_tier is system-
  // computed from smoothed MRR; billed_tier is what the customer is
  // actually subscribed to (never auto-updated). Migration 051.
  recommendedTier:        text('recommended_tier'),
  billedTier:             text('billed_tier'),
  smoothedMrrUsdMinor:    bigint('smoothed_mrr_usd_minor', { mode: 'number' }),
  smoothedMrrComputedAt:  timestamp('smoothed_mrr_computed_at'),
  requiresSales:          boolean('requires_sales').notNull().default(false),
  recommendedChangedAt:   timestamp('recommended_changed_at'),
  billedChangedAt:        timestamp('billed_changed_at'),
  createdAt:            timestamp('created_at').defaultNow(),
  updatedAt:            timestamp('updated_at').defaultNow(),
}, (table) => ({
  // Spec 56 — one Stripe Connect account links to at most one Winback
  // customer row. Partial: NULL stripe_account_id rows are unaffected.
  // OAuth callback (`app/api/stripe/callback/route.ts`) pre-checks for
  // duplicates and redirects with a friendly error; this index is the
  // DB-level guarantee in case the pre-check is bypassed (race).
  stripeAccountIdUnique: uniqueIndex('customers_stripe_account_id_unique')
    .on(table.stripeAccountId)
    .where(sql`${table.stripeAccountId} IS NOT NULL`),
}))

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
  // Spec 71 — `reply_text` column dropped in migration 041. Replies are
  // now in their own table `wb_subscriber_replies` (one row per inbound).
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
  // Spec 54 — Drain on subscribe. Set by /api/cron/drain-paused-queue
  // when a row reaches a terminal outcome (sent / classifier-suppressed /
  // handoff). Rows with NULL here AND a subscribed-customer with
  // activated_at set are the queue. See spec 54 for the partial index
  // (idx_wb_churned_subscribers_drain_queue) that powers the cron filter.
  pauseDrainProcessedAt: timestamp('pause_drain_processed_at'),
  // Spec 21b — founder handoff
  founderHandoffAt:           timestamp('founder_handoff_at'),
  founderHandoffResolvedAt:   timestamp('founder_handoff_resolved_at'),
  // Spec 22a — AI pause (generalized from the spec 21 handoff snooze).
  //            ai_paused_until replaces the old founder_handoff_snoozed_until column.
  aiPausedUntil:              timestamp('ai_paused_until'),
  aiPausedAt:                 timestamp('ai_paused_at'),
  aiPausedReason:             text('ai_paused_reason'),
  // DEPRECATED — kept during the Phase 1–7 transition. Will be dropped in
  // a later migration once all reader code is cleaned up. Migration 017.
  handoffReasoning:           text('handoff_reasoning'),
  recoveryLikelihood:         text('recovery_likelihood'),   // 'high'|'medium'|'low'
  // Drawer insight (replaces handoff_reasoning as the founder-facing AI
  // commentary). Populated on every classification pass. Migration 050.
  drawerInsightRead:          text('drawer_insight_read').notNull().default(''),
  drawerInsightWorthKnowing:  text('drawer_insight_worth_knowing').notNull().default(''),
  // Spec 33 — multi-touch dunning state machine. The webhook captures
  // Stripe's invoice.next_payment_attempt on every payment_failed event;
  // the daily cron picks up rows whose retry is in the next 12-36h window
  // and sends T2/T3. Migration 028.
  nextPaymentAttemptAt:       timestamp('next_payment_attempt_at'),
  dunningTouchCount:          integer('dunning_touch_count').notNull().default(0),
  dunningLastTouchAt:         timestamp('dunning_last_touch_at'),
  dunningState:               text('dunning_state'),
  // Values: 'awaiting_retry' | 'final_retry_pending'
  //       | 'recovered_during_dunning' | 'churned_during_dunning'
  // Spec 34 — last decline_code from invoice.last_payment_error.
  // Drives bespoke "why this happened" copy in T1/T2/T3.
  lastDeclineCode:            text('last_decline_code'),
  // Spec 65 — derived bucket from classifier confidence + triggerNeed
  // presence. 'high' = eligible for re-engagement matching; 'low' = silent
  // churn, never matched (still receives the exit email). Migration 039.
  triggerNeedConfidence:      text('trigger_need_confidence'),  // 'high' | 'low' | null
  // Spec 65 — cooldown timestamp scoped to re-engagement emails. Matcher
  // won't fire again on this subscriber if this is within the last 60
  // days. Distinct from reengagementSentAt which was the old single-shot
  // field.
  lastReengagedAt:            timestamp('last_reengaged_at', { withTimezone: true }),
  // Spec 65 — set by daily expiry sweep when the subscriber hits 9 months
  // post-cancellation without recovering. Permanently disqualifies them
  // from future re-engagement.
  reengagementExpiredAt:      timestamp('reengagement_expired_at', { withTimezone: true }),
  // Spec 72 — producer/consumer classifier. classified_at NULL means
  // the row is waiting in the queue for the classifier cron. Webhook
  // inserts and backfill inserts both start NULL; cron sets it to NOW()
  // after successful classification.
  classifiedAt:          timestamp('classified_at', { withTimezone: true }),
  // Per-row retry counter. Cron's WHERE clause filters classify_attempts < 3,
  // so rows that fail 3 times drop out of the queue and emit a
  // classify_dead_lettered event for admin review.
  classifyAttempts:      integer('classify_attempts').notNull().default(0),
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
  // Spec 65 — links re-engagement emails to the improvement that triggered
  // them. NULL for non-re-engagement emails. Migration 039.
  improvementId:  uuid('improvement_id'),
})

// Spec 71 — append-only inbound reply history. One row per inbound reply
// the subscriber sends. Replaces the overwritten `reply_text` column on
// wb_churned_subscribers so we keep the full conversation. Migration 041.
export const subscriberReplies = pgTable('wb_subscriber_replies', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  subscriberId:       uuid('subscriber_id').notNull().references(() => churnedSubscribers.id, { onDelete: 'cascade' }),
  body:               text('body').notNull(),
  fromEmail:          text('from_email'),
  receivedAt:         timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  // Resend's inbound email_id; UNIQUE constraint at the DB layer is a
  // second line of defense against double-insert beyond Spec 64's
  // wb_inbound_events idempotency token.
  resendEmailId:      text('resend_email_id').unique(),
  // The outbound this was a reply to, matched via RFC822 In-Reply-To
  // header. NULL when threading didn't resolve.
  inReplyToEmailId:   uuid('in_reply_to_email_id').references(() => emailsSent.id, { onDelete: 'set null' }),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  subscriberReceivedIdx: index('idx_wb_subscriber_replies_subscriber_received')
    .on(t.subscriberId, t.receivedAt),
}))

// Spec 65 — Winback Reasons. Each row is a single shipped product
// improvement the merchant wants to communicate to cancelled customers
// who asked for something like it. Migration 039.
// Spec 78 — also stores Stripe-synced promotion codes when kind='promotion'.
// `promotionMetadata` holds the Stripe coupon+promotion-code snapshot
// (shape: WbPromotionMetadata Zod schema in src/winback/lib/promotions.ts).
export const improvements = pgTable('wb_improvements', {
  id:               uuid('id').primaryKey().defaultRandom(),
  customerId:       uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  title:            text('title').notNull(),
  description:      text('description').notNull(),
  // Postgres DATE column (date-only, no time). Drizzle's `date` returns
  // ISO string ('YYYY-MM-DD') in string mode — simpler than dealing with
  // partial Date objects on the server-rendered side.
  dateShipped:      date('date_shipped', { mode: 'string' }).notNull(),
  // 'published' | 'archived'. No 'draft' state — single Save = Publish.
  status:           text('status').notNull().default('published'),
  // Free-text label of the customer-demand pattern this addresses, or null
  // when the merchant used "Add anyway" (pre-emptive ship with no signal yet).
  addressesPattern: text('addresses_pattern'),
  preempted:        boolean('preempted').notNull().default(false),
  // Spec 78 — 'product' (default) for merchant-authored improvements,
  // 'promotion' for Stripe-synced promotion codes. Discriminator drives
  // matcher routing and UI section grouping.
  kind:             text('kind').notNull().default('product'),
  // Spec 78 — only populated when kind='promotion'. JSON snapshot of the
  // Stripe coupon + promotion code at last sync. See WbPromotionMetadata.
  promotionMetadata: jsonb('promotion_metadata').$type<Record<string, unknown>>(),
  createdAt:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archivedAt:       timestamp('archived_at', { withTimezone: true }),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  customerStatusIdx: index('idx_wb_improvements_customer_status').on(t.customerId, t.status),
  dateShippedIdx:    index('idx_wb_improvements_date_shipped').on(t.customerId, t.dateShipped),
}))

// Spec 65 — Records which improvement matched which subscriber. Primary
// key on (improvement_id, subscriber_id) enforces "each customer hears
// about an improvement at most once" mechanically. emailed_at is set
// when the re-engagement email actually sent (NULL if the matcher fired
// but the email was aborted by the sanity check).
export const improvementMatches = pgTable('wb_improvement_matches', {
  improvementId: uuid('improvement_id').notNull().references(() => improvements.id, { onDelete: 'cascade' }),
  subscriberId:  uuid('subscriber_id').notNull().references(() => churnedSubscribers.id, { onDelete: 'cascade' }),
  matchedAt:     timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  emailedAt:     timestamp('emailed_at', { withTimezone: true }),
}, (t) => ({
  pk:            primaryKey({ columns: [t.improvementId, t.subscriberId] }),
  subscriberIdx: index('idx_wb_improvement_matches_subscriber').on(t.subscriberId),
}))

// Spec 79 — AI-clustered cancellation themes. Snapshot model: the weekly
// cron wipes prior rows for a customer and inserts fresh on each run.
// addressesImprovementId is NULL for primary themes (unmatched-cancellation
// clusters surfacing what to ship next) and set for post-ship insights
// (customers cancelled citing a problem you already shipped a reason for).
// Migration 047.
export const cancellationThemes = pgTable('wb_cancellation_themes', {
  id:                       uuid('id').primaryKey().defaultRandom(),
  customerId:               uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  addressesImprovementId:   uuid('addresses_improvement_id').references(() => improvements.id, { onDelete: 'cascade' }),
  title:                    text('title').notNull(),
  description:              text('description').notNull(),
  category:                 text('category'),                                    // 'Price' | 'Feature' | 'Other'
  emoji:                    text('emoji'),
  customerCount:            integer('customer_count').notNull(),
  subscriberIds:            uuid('subscriber_ids').array().notNull(),
  sampleQuotes:             text('sample_quotes').array().notNull(),
  windowStart:              timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd:                timestamp('window_end', { withTimezone: true }).notNull(),
  createdAt:                timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  customerCreatedIdx: index('idx_wb_cancellation_themes_customer_created').on(t.customerId, t.createdAt),
}))

// Spec 64 — Resend inbound webhook dedup ledger. Primary-keyed on
// Resend's email_id; a second webhook with the same id conflicts on
// INSERT and short-circuits before any DB mutation. See migration 038
// and app/api/email/inbound/route.ts for the gate.
export const inboundEvents = pgTable('wb_inbound_events', {
  emailId:      text('email_id').primaryKey(),
  source:       text('source').notNull().default('resend_inbound'),
  receivedAt:   timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  subscriberId: uuid('subscriber_id'),
  outcome:      text('outcome').notNull(),  // 'reserved' | 'processed' | 'no_subscriber_id' | 'subscriber_not_found' | 'empty_reply_text'
}, (t) => ({
  receivedAtIdx: index('idx_wb_inbound_events_received_at').on(t.receivedAt),
}))

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

// Spec 32 — Email verification tokens. Single-use, 7-day expiry, sha256-hashed.
// Mirrors password-reset model. Issued at /api/auth/register, redeemed at
// /verify-email, also re-issued via /api/auth/resend-verification.
export const emailVerificationTokens = pgTable('wb_email_verification_tokens', {
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
  attributionType:   text('attribution_type'),
  // 'win_back' (voluntary cancel → reactivation) or 'card_save' (failed
  // payment recovered). Both count toward the ROI display when
  // attributionType is 'strong' or 'weak'; neither bills a per-recovery
  // fee in the tiered-pricing model.
  recoveryType:      text('recovery_type'),
  // Spec 79 — FK to the wb_improvements row (kind='promotion') that
  // drove this recovery. Null for recoveries that didn't have a promo
  // attached. Populated by reengagement-cron-v2's promo path. Powers
  // the dashboard chip and /reasons per-code metric.
  appliedImprovementId: uuid('applied_improvement_id')
    .references(() => improvements.id, { onDelete: 'set null' }),
})

export const mrrSnapshots = pgTable('wb_mrr_snapshots', {
  id:                          bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  customerId:                  uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  mrrUsdMinor:                 bigint('mrr_usd_minor', { mode: 'number' }).notNull(),
  perCurrency:                 jsonb('per_currency').notNull(),
  breakdown:                   jsonb('breakdown').notNull(),
  stripeReportedMrrUsdMinor:   bigint('stripe_reported_mrr_usd_minor', { mode: 'number' }),
  source:                      text('source').notNull(),
  takenAt:                     timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  customerTakenAtIdx: index('idx_mrr_snapshots_customer_taken_at')
    .on(table.customerId, table.takenAt.desc()),
}))

export const fxRates = pgTable('wb_fx_rates', {
  currency:   text('currency').primaryKey(),
  rateUsd:    decimal('rate_usd', { precision: 18, scale: 8 }).notNull(),
  fetchedAt:  timestamp('fetched_at', { withTimezone: true }).notNull(),
})

// Migration 052 — in-product feature request intake. Replaces the
// dormant "Notifications email" field on Settings. status + shippedAt
// exist so the future close-the-loop email cron has somewhere to
// record state; the mechanism itself is deferred.
export const featureRequests = pgTable('wb_feature_requests', {
  id:                bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  customerId:        uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  // Email of the user who submitted (resolved server-side from session,
  // never client-supplied). Denormalised so historical attribution
  // survives even if the user row changes.
  submittedByEmail:  text('submitted_by_email').notNull(),
  body:              text('body').notNull(),
  status:            text('status').notNull().default('new'),
  submittedAt:       timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  shippedAt:         timestamp('shipped_at', { withTimezone: true }),
}, (table) => ({
  customerSubmittedAtIdx: index('idx_feature_requests_customer_submitted_at')
    .on(table.customerId, table.submittedAt.desc()),
  statusSubmittedAtIdx: index('idx_feature_requests_status_submitted_at')
    .on(table.status, table.submittedAt.desc()),
}))

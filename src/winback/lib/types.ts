export type SubscriberStatus = 'pending' | 'contacted' | 'recovered' | 'lost' | 'skipped'
export type EmailType        = 'exit' | 'win_back' | 'followup' | 'reengagement'

/**
 * Spec 71 — one turn in the subscriber's conversation, used by the
 * classifier to read the full thread (vs. just the latest reply).
 * `kind: 'outbound'` is an email we sent; `kind: 'reply'` is the
 * subscriber's response. Bodies are truncated to ~3 KB at builder time
 * so the rendered prompt stays under ~30 KB even at the 10-turn max.
 */
export interface ConversationTurn {
  kind:        'outbound' | 'reply'
  at:          Date
  emailType?:  string  // only on outbound: 'exit' | 'followup' | 'reengagement' | 'dunning'
  subject?:    string  // only on outbound
  body:        string
  truncated?:  boolean // true if we clipped this turn's body to fit
}

export interface SubscriberSignals {
  stripeCustomerId:     string
  stripeSubscriptionId: string
  stripePriceId:        string | null
  email:                string | null
  name:                 string | null
  planName:             string
  mrrCents:             number
  tenureDays:           number
  everUpgraded:         boolean
  nearRenewal:          boolean
  paymentFailures:      number
  previousSubs:         number
  stripeEnum:           string | null
  stripeComment:        string | null
  /**
   * Spec 71 — chronological conversation thread (most-recent last,
   * capped at 10 turns by the builder). Replaces the old single-string
   * `replyText` field; classifier prompt renders this as a block.
   * Empty / undefined → no conversation context yet (first-pass
   * classification at cancel time).
   */
  conversationThread?: ConversationTurn[]
  billingPortalClicked?: boolean
  cancelledAt:          Date
  /**
   * Number of emails we've already sent to this subscriber in this churn
   * cycle (0, 1, or 2). The classifier uses this to decide whether the next
   * slot is better spent as an AI follow-up or as a founder hand-off.
   * 3 is the hard ceiling — after that, no more emails go out.
   */
  emailsSent?:          number
  /**
   * Spec 54 — days since the triggering event (cancellation for category A,
   * reply for category C). Drain-on-subscribe sets this when re-classifying
   * subscribers whose email was blocked during the paused window — lets the
   * model factor in time decay against the cancellation reason (a "missing
   * feature" cancel decays faster than a "too expensive" one).
   * Unset / undefined for the normal real-time classification path.
   */
  daysElapsedSinceEvent?: number
}

export type RecoveryLikelihood = 'high' | 'medium' | 'low'

export interface ClassificationResult {
  tier:                 1 | 2 | 3 | 4
  tierReason:           string
  cancellationReason:   string
  cancellationCategory: string
  confidence:           number
  suppress:             boolean
  suppressReason?:      string | null
  firstMessage: {
    subject:        string
    body:           string
    sendDelaySecs:  number
  } | null
  triggerKeyword:  string | null  // Legacy — kept during transition (spec 19b)
  triggerNeed:     string | null  // Rich description of subscriber's stated need (spec 19b)
  winBackSubject:  string         // Deprecated by spec 19c — generated at match time now
  winBackBody:     string         // Deprecated by spec 19c — generated at match time now
  /**
   * Drawer insight — purely descriptive summary shown to the founder above
   * the conversation. Replaces the deprecated `handoff` / `handoffReasoning`
   * pair (there is no automatic handoff anymore — AI keeps running on every
   * subscriber, the founder takes over manually when they want).
   *
   * `read`         — what's happening (1 sentence, ~100 chars target)
   * `worthKnowing` — specific detail the founder should be aware of, or ''
   *
   * Optional in the type so test fixtures and legacy code paths don't have
   * to construct it explicitly. The Zod schema in classifier.ts always
   * defaults it to `{ read: '', worthKnowing: '' }`, so real classifications
   * from `classifySubscriber()` always have it set.
   */
  drawerInsight?: {
    read:         string
    worthKnowing: string
  }
  recoveryLikelihood: RecoveryLikelihood
  /** @deprecated Removed in Phase 7. AI no longer emits this — always false. */
  handoff:            boolean
  /** @deprecated Removed in Phase 7. AI no longer emits this — always ''. */
  handoffReasoning:   string
}

export interface DashboardStats {
  recoveryRate:       number
  recovered:          number
  mrrRecoveredCents:  number
  pending:            number
}

export type SubscriberStatus = 'pending' | 'contacted' | 'recovered' | 'lost' | 'skipped'
export type EmailType        = 'exit' | 'win_back' | 'followup' | 'reengagement'

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
  replyText?:           string | null
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
   * AI-decided hand-off judgment (replaces the count-based MAX_FOLLOWUPS rule).
   * The classifier decides on every pass whether the subscriber is better
   * served by another AI email or by a personal reply from the founder,
   * balancing convertibility, founder-inbox cost, and the 3-email budget.
   */
  handoff:            boolean
  handoffReasoning:   string
  recoveryLikelihood: RecoveryLikelihood
}

export interface DashboardStats {
  recoveryRate:       number
  recovered:          number
  mrrRecoveredCents:  number
  pending:            number
}

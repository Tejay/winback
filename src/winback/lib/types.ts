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
}

export interface ClassificationResult {
  tier:                 1 | 2 | 3 | 4
  tierReason:           string
  cancellationReason:   string
  cancellationCategory: string
  confidence:           number
  suppress:             boolean
  suppressReason?:      string
  firstMessage: {
    subject:        string
    body:           string
    sendDelaySecs:  number
  } | null
  triggerKeyword:  string | null  // Legacy — kept during transition (spec 19b)
  triggerNeed:     string | null  // Rich description of subscriber's stated need (spec 19b)
  winBackSubject:  string         // Deprecated by spec 19c — generated at match time now
  winBackBody:     string         // Deprecated by spec 19c — generated at match time now
}

export interface DashboardStats {
  recoveryRate:       number
  recovered:          number
  mrrRecoveredCents:  number
  pending:            number
}

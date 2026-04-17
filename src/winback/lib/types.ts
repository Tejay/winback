export type SubscriberStatus = 'pending' | 'contacted' | 'recovered' | 'lost' | 'skipped'
export type EmailType        = 'exit' | 'win_back' | 'followup'

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
  triggerKeyword:  string | null
  fallbackDays:    30 | 90 | 180
  winBackSubject:  string
  winBackBody:     string
}

export interface DashboardStats {
  recoveryRate:       number
  recovered:          number
  mrrRecoveredCents:  number
  pending:            number
}

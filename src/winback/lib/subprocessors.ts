/**
 * Subprocessors that receive personal data of our customers' churned subscribers.
 * Used by /subprocessors page and DPA appendix. Keep this list accurate — if you
 * add or remove a subprocessor, update LEGAL_VERSION and notify customers (Tier 2).
 */

export interface Subprocessor {
  name: string
  purpose: string
  dataProcessed: string
  location: string
  transferMechanism: string
  url: string
}

export const SUBPROCESSORS: Subprocessor[] = [
  {
    name: 'Vercel Inc.',
    purpose: 'Application hosting and edge delivery',
    dataProcessed: 'All application data in transit; operational logs',
    location: 'United States (global edge)',
    transferMechanism: 'EU Standard Contractual Clauses',
    url: 'https://vercel.com/legal/privacy-policy',
  },
  {
    name: 'Neon Inc.',
    purpose: 'Managed Postgres database',
    dataProcessed: 'Subscriber email, name, cancellation reason, billing metadata',
    location: 'United States (AWS us-east-2)',
    transferMechanism: 'EU Standard Contractual Clauses',
    url: 'https://neon.tech/privacy-policy',
  },
  {
    name: 'Anthropic PBC',
    purpose: 'LLM classification of cancellation reasons',
    dataProcessed: 'Subscriber signals sent to Claude for classification (zero-retention mode enabled)',
    location: 'United States',
    transferMechanism: 'EU Standard Contractual Clauses',
    url: 'https://www.anthropic.com/legal/privacy',
  },
  {
    name: 'Resend Inc.',
    purpose: 'Transactional email delivery and inbound parsing',
    dataProcessed: 'Subscriber email address, email content, delivery metadata',
    location: 'United States',
    transferMechanism: 'EU Standard Contractual Clauses',
    url: 'https://resend.com/legal/privacy-policy',
  },
  {
    name: 'Stripe Inc.',
    purpose: 'OAuth connection to customer Stripe account; webhook delivery',
    dataProcessed: 'Stripe customer IDs, subscription metadata (read-only)',
    location: 'United States / Ireland',
    transferMechanism: 'EU Standard Contractual Clauses',
    url: 'https://stripe.com/privacy',
  },
]

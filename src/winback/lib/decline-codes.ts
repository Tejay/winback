/**
 * Spec 34 — Stripe decline_code → bespoke email copy.
 *
 * Pure rule-based mapper. No I/O, no LLM, no external lookups. Stripe
 * documents ~25 decline codes; ~85% of real-world declines fall into
 * 5–6 buckets, so we render bespoke "why this happened" + "best next
 * step" copy for those and let the long tail fall through to a
 * generic fallback (today's behaviour, unchanged).
 *
 * Operationally:
 *   - The webhook captures `last_decline_code` on every
 *     invoice.payment_failed event.
 *   - sendDunningEmail / sendDunningFollowupEmail read the column at
 *     send time and call declineCodeToCopy() to choose the lines that
 *     get woven into both the text body and the HTML body.
 *   - `temporary` bucket suppresses the update-payment CTA — no point
 *     pushing the customer to act when Stripe is at fault.
 */

export type DeclineBucket =
  | 'expired'
  | 'insufficient_funds'
  | 'bank_declined'
  | 'card_flagged'
  | 'fraud_review'
  | 'temporary'
  | 'fallback'

export interface DeclineCopy {
  bucket:               DeclineBucket
  reason:               string  // "Why this happened" line
  action:               string  // "Best next step" line
  suppressUpdateCta?:   boolean // true for 'temporary' — don't push update
}

const FALLBACK: DeclineCopy = {
  bucket: 'fallback',
  reason: "We tried to charge your card but it didn't go through. This usually happens when a card expires or the bank declines it.",
  action: 'Update the card on file or try a different one.',
}

const EXPIRED: DeclineCopy = {
  bucket: 'expired',
  reason: 'Your card expired since the last successful charge.',
  action: 'Update the card details (or use a different card) before our next retry.',
}

const INSUFFICIENT_FUNDS: DeclineCopy = {
  bucket: 'insufficient_funds',
  reason: 'Your card was declined for insufficient funds.',
  action: "We'll retry automatically — no action needed if funds will be available by then. Or update to a different card now.",
}

const BANK_DECLINED: DeclineCopy = {
  bucket: 'bank_declined',
  reason: "Your bank declined the charge. They don't always tell us why.",
  action: "Trying a different card usually works. If you'd rather use the same card, call the number on the back to pre-authorise the next charge.",
}

const CARD_FLAGGED: DeclineCopy = {
  bucket: 'card_flagged',
  reason: "The card on file was reported missing or isn't supported for this charge.",
  action: 'Use a different card to keep your subscription active.',
}

const FRAUD_REVIEW: DeclineCopy = {
  bucket: 'fraud_review',
  reason: "Your bank flagged the charge as potentially fraudulent — they're protecting you.",
  action: "Call the number on the back of your card to confirm the charge with them, then we'll retry. Or use a different card.",
}

const TEMPORARY: DeclineCopy = {
  bucket: 'temporary',
  reason: "There was a temporary issue processing the charge — this isn't usually anything on your end.",
  action: "We'll retry automatically. No action needed unless the next email says otherwise.",
  suppressUpdateCta: true,
}

const STRIPE_DECLINE_MAP: Record<string, DeclineCopy> = {
  expired_card:             EXPIRED,
  insufficient_funds:       INSUFFICIENT_FUNDS,
  do_not_honor:             BANK_DECLINED,
  card_declined:            BANK_DECLINED,
  generic_decline:          BANK_DECLINED,
  lost_card:                CARD_FLAGGED,
  stolen_card:              CARD_FLAGGED,
  card_not_supported:       CARD_FLAGGED,
  card_velocity_exceeded:   FRAUD_REVIEW,
  fraudulent:               FRAUD_REVIEW,
  pickup_card:              FRAUD_REVIEW,
  processing_error:         TEMPORARY,
  try_again_later:          TEMPORARY,
}

export function declineCodeToCopy(code: string | null | undefined): DeclineCopy {
  if (!code) return FALLBACK
  return STRIPE_DECLINE_MAP[code] ?? FALLBACK
}

# Spec 34 — Decline-code-aware copy in dunning emails (T1, T2, T3)

**Phase:** Pre-launch hardening
**Depends on:** Spec 09 (`processPaymentFailed`), Spec 33 (multi-touch
dunning emails — T2/T3), Spec 28 (idempotent email send)
**Estimated time:** ~half a day
**Numbering note:** This slot was reserved when Spec 33 shipped. We
jumped to Spec 35 (Checkout Session) first because the wallet-visibility
question surfaced before this one. Spec 34 is unblocked now.

---

## Context

Today, T1 / T2 / T3 dunning emails (Specs 09, 33) all use the same
generic explanation regardless of *why* the card declined:

> *We tried to charge your card for {plan} but it didn't go through.
>  This usually happens when a card expires or the bank declines it.*

Stripe gives us the actual reason on every `invoice.payment_failed`
webhook via `invoice.last_payment_error.decline_code` (specific) and
`invoice.last_payment_error.code` (broader). We currently throw it away.

The reasons are wildly different in terms of *what the customer should
do next*:

| Decline | What customer should do |
|---|---|
| `expired_card` | Update the card with the new expiry date |
| `insufficient_funds` | Wait for next paycheck or use a different card |
| `do_not_honor` (bank-level block) | Try a different card or call their bank |
| `lost_card` / `stolen_card` (bank-flagged) | Use a different card |
| `card_velocity_exceeded` (anti-fraud) | Call the bank to authorise |
| `processing_error` (Stripe-side) | No action — Stripe will retry |

The generic copy hides all of this. Customers reading "the bank declined
it" when their card actually *expired* shrug and ignore the email —
they don't know they need to update the card. Stripe's own dunning
literature consistently cites decline-code-aware copy as one of the
highest-ROI dunning improvements, ahead of timing changes and ahead of
landing-page design.

This spec adds a small rule-based layer that:

1. Captures `decline_code` on every `payment_failed` webhook
2. Renders 1–2 sentences of reason + action coaching into the dunning
   email bodies (T1, T2, T3) based on the code
3. Falls back to the existing generic copy for unknown codes

No LLM. Pure rule-based switch. ~half a day.

---

## Goals

| # | Goal | Mechanism |
|---|------|-----------|
| 1 | Customer reads T1/T2/T3 and immediately understands *why* their card failed | New "Why this happened" line, switched on `decline_code` |
| 2 | Customer reads T1/T2/T3 and knows *what to do* (with specificity) | New "Best next step" line, switched on `decline_code` |
| 3 | The same machinery covers T1, T2, and T3 — single source of truth | Shared `declineCodeToCopy()` helper, called from both email functions |
| 4 | Unknown / missing decline codes don't break anything | Fallback bucket returns the existing generic copy |

---

## Non-goals

- **AI-drafted decline messages.** Rule-based is faster, cheaper, more
  predictable, and decline-code variability is bounded — there are
  ~25 codes in Stripe's docs, and ~85% of real declines fall in 5–6
  buckets. LLM is overkill.
- **Decline-code-aware *subject* lines.** Tempting (open rate lift), but
  varying subjects across T1/T2/T3 hurts Gmail thread continuity and
  doubles the test matrix. Keep subjects stable; put all variation in
  the body. Revisit if open rates plateau.
- **Decline-code-aware *retry timing*.** Stripe Smart Retries already
  does this server-side. We don't override it.
- **Per-merchant copy overrides.** Pilot scale is 10 merchants; not
  worth the config UI burden.
- **Localisation.** English only for v1. Mappings live in a single TS
  file; future localisation is a `code → locale → string` lookup.
- **Surfacing decline code in `/dashboard`.** Useful but separable. Out
  of scope.
- **Enriching the *win-back* email** (voluntary cancellation) with
  decline-code copy. Not relevant — win-back is for "I cancelled on
  purpose," not "my card failed."

---

## Decision: which decline codes get bespoke copy

Stripe documents ~25 decline codes. We don't need a mapping for every
one — distribution is heavily skewed. Bespoke copy for the common
buckets, generic copy for the long tail.

**Buckets we handle bespoke (~85% of real volume):**

| Bucket | Stripe codes mapped here | Reason copy | Action copy |
|---|---|---|---|
| Expired | `expired_card` | "Your card expired since the last successful charge." | "Update the card details (or use a different card) before our next retry." |
| Insufficient funds | `insufficient_funds` | "Your card was declined for insufficient funds." | "We'll retry automatically — no action needed if funds will be available by then. Or update to a different card now." |
| Bank declined (generic) | `do_not_honor`, `card_declined`, `generic_decline` | "Your bank declined the charge. They don't always tell us why." | "Trying a different card usually works. If you'd rather use the same card, call the number on the back to pre-authorise the next charge." |
| Card flagged | `lost_card`, `stolen_card`, `card_not_supported` | "The card on file was reported missing or isn't supported for this charge." | "Use a different card to keep your subscription active." |
| Anti-fraud | `card_velocity_exceeded`, `fraudulent`, `pickup_card` | "Your bank flagged the charge as potentially fraudulent — they're protecting you." | "Call the number on the back of your card to confirm the charge with them, then we'll retry. Or use a different card." |
| Stripe-side / temporary | `processing_error`, `try_again_later` | "There was a temporary issue processing the charge — this isn't usually anything on your end." | "We'll retry automatically. No action needed unless the next email says otherwise." |

**Long-tail bucket (~15%):**

Anything not in the table above (CVV mismatch on a saved card,
authentication required, currency not supported, etc.) → falls through
to the existing generic copy:

> *We tried to charge your card for {plan} but it didn't go through.
>  This usually happens when a card expires or the bank declines it.*

Plus a generic "update your card or try a different one" action line.

We can grow the table from real production data once the cron has run
for a couple of weeks. The fallback ensures unhandled codes never break
anything.

**Special-case nuance: `processing_error` doesn't push the customer to
update their card.** Pushing them to "update payment" when Stripe is at
fault is a bad experience. The action copy explicitly says "no action
needed" — they only see an update link in the footer for completeness.

---

## Schema (migration 029)

```sql
-- Spec 34 — capture the latest decline code from invoice.payment_failed
-- so dunning email copy can be specific to the failure reason.
--
-- Stored as a single text column (not JSONB) — we only need the code
-- itself to drive copy rendering. The full last_payment_error object
-- is available in Stripe's invoice and we can re-fetch if richer
-- diagnostics are ever needed.
--
-- Always overwritten with the LATEST decline_code on every retry: a
-- bank may return different reasons across attempts (e.g. attempt 1
-- = insufficient_funds, attempt 2 = do_not_honor a week later because
-- the customer's bank flagged the merchant). We always copy from the
-- most recent invoice.

ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS last_decline_code TEXT;
```

No backfill needed — existing rows (which all already have generic
copy) just carry `NULL`, which the copy renderer treats as the fallback
bucket. New T1s captured after the migration get the specific code
immediately.

---

## Code changes

### 1. `lib/schema.ts`

Add the column to the Drizzle table definition. One line:

```ts
lastDeclineCode: text('last_decline_code'),
```

### 2. New module: `src/winback/lib/decline-codes.ts`

Pure rule-based mapper. ~80 lines of code + the table above translated
to a `Record<string, DeclineBucket>`:

```ts
export type DeclineBucket =
  | 'expired'
  | 'insufficient_funds'
  | 'bank_declined'
  | 'card_flagged'
  | 'fraud_review'
  | 'temporary'
  | 'fallback'

export interface DeclineCopy {
  bucket: DeclineBucket
  reason: string         // "Your card expired since the last successful charge."
  action: string         // "Update the card details ..."
  suppressUpdateCta?: boolean  // true for 'temporary' bucket — don't push update
}

export function declineCodeToCopy(code: string | null | undefined): DeclineCopy {
  if (!code) return FALLBACK
  return STRIPE_DECLINE_MAP[code] ?? FALLBACK
}
```

The map is the single source of truth. New codes are added by editing
this file plus its test. No DB seeding, no env vars.

### 3. `app/api/stripe/webhook/route.ts` — `processPaymentFailed`

Add one read + one column to the existing upsert:

```ts
// invoice.last_payment_error is { code, decline_code, message, ... }
// decline_code is the specific code (e.g. 'insufficient_funds');
// fall back to the broader code (e.g. 'card_declined') if absent.
const lastPaymentError = invoice.last_payment_error ?? null
const declineCode: string | null =
  lastPaymentError?.decline_code ?? lastPaymentError?.code ?? null
```

Then in both branches that write/update `wb_churned_subscribers`:

```ts
.set({
  // existing fields...
  lastDeclineCode: declineCode,
})
```

This runs on **every** `payment_failed` (attempt 1 + retries), so the
column always reflects the most recent decline reason. T2 and T3 read
it at send time.

### 4. `src/winback/lib/email.ts` — `sendDunningEmail`

Pull the latest decline code from the subscriber row, look up copy,
weave into the body:

```ts
import { declineCodeToCopy, DeclineCopy } from './decline-codes'

// inside sendDunningEmail, after the existing setup:
const [{ lastDeclineCode }] = await db
  .select({ lastDeclineCode: churnedSubscribers.lastDeclineCode })
  .from(churnedSubscribers)
  .where(eq(churnedSubscribers.id, subscriberId))
  .limit(1)

const copy = declineCodeToCopy(lastDeclineCode)

// body now has 2 new lines after the opener:
body = `Hi ${name},

We tried to charge your card for ${planName} (${amount} ${currency.toUpperCase()}) but it didn't go through.

Why this happened: ${copy.reason}

Best next step: ${copy.action}
${copy.suppressUpdateCta ? '' : `\nUpdate your payment method here:\n${updateLink}\n`}
${nextRetryDate ? `We'll try again on ${retryDateStr} — updating before then means no interruption to your service.` : ''}

If you have any questions, just reply to this email.

— ${fromName}

— — —
If you'd rather not hear from us, unsubscribe: ${unsubLink}`
```

The `suppressUpdateCta` branch only fires for the `temporary` bucket
(Stripe-side processing error). Everywhere else the update link still
appears.

### 5. `src/winback/lib/dunning-followup.ts` — T2/T3

The cron's `EligibleRow` type already pulls a row from
`wb_churned_subscribers`. Add `lastDeclineCode` to the select +
interface, pass it to `sendDunningFollowupEmail`. Then mirror the
email.ts changes in the T2/T3 body templates.

T3 in particular benefits from the action coaching — it's the customer's
last chance, and "your bank flagged the charge" gives them a concrete
thing to do (call the bank) versus the generic copy's vague "update or
lose access."

### 6. No changes to:

- `wb_emails_sent` types or idempotency
- The Checkout Session redirect (Spec 35)
- The cron schedule
- The `/welcome-back` page

---

## Tests (~7 new)

Pattern: `vi.hoisted` mocks of `@/lib/db` for the email tests, plus a
plain TS test file for the decline-codes module (no DB needed).

`src/winback/__tests__/decline-codes.test.ts` (~5 tests):

- `expired_card` → bucket 'expired', reason mentions "expired", action mentions "update"
- `insufficient_funds` → bucket 'insufficient_funds', action mentions "different card"
- `do_not_honor` → bucket 'bank_declined', action mentions "call the number"
- `processing_error` → bucket 'temporary', `suppressUpdateCta: true`
- `unknown_code_xyz` → bucket 'fallback', generic copy

`src/winback/__tests__/dunning-emails.test.ts` (extend existing, +2):

- `sendDunningEmail` body contains the bespoke reason/action when
  `wb_churned_subscribers.lastDeclineCode = 'expired_card'`
- `sendDunningFollowupEmail` (T3) body contains "call the number" when
  `lastDeclineCode = 'card_velocity_exceeded'` and `isFinalRetry: true`

Existing tests keep passing because the fallback bucket returns the
same generic copy that's hardcoded today (we're moving it into the
fallback constant, not changing the customer-visible default).

---

## Verification

```bash
git checkout -b feat/spec-34-decline-code-copy
# (after writes)
psql $DATABASE_URL -f src/winback/migrations/029_decline_code_capture.sql   # ASK BEFORE
npx tsc --noEmit
npx vitest run

# Decline-code mapping unit tests
npx vitest run src/winback/__tests__/decline-codes.test.ts -t "expired"

# End-to-end manual via Stripe test events (re-use the dunning-e2e
# harness from Spec 33):
# 1. scripts/dunning-e2e.ts with attempt 1 — using test card
#    4000000000000341 (insufficient_funds) — confirms:
#      psql: wb_churned_subscribers.last_decline_code = 'insufficient_funds'
#      inbox: T1 body contains "declined for insufficient funds"
#      inbox: T1 body contains "Or update to a different card now"
# 2. Trigger another payment_failed with attempt_count=3 + decline_code=
#    'do_not_honor' — confirms:
#      psql: last_decline_code overwritten to 'do_not_honor'
#      inbox (after backdating + cron): T3 body contains "call the
#      number on the back of your card"
# 3. Trigger payment_failed with code = 'processing_error' — confirms:
#      inbox: T1 body says "no action needed"
#      inbox: NO update-payment link in the body (suppressed for this bucket)
# 4. Trigger payment_failed with an unknown code — confirms fallback
#    body matches the existing generic copy verbatim.
```

---

## Edge cases handled

1. **Decline code missing entirely.** Stripe doesn't always include
   `last_payment_error` — older invoice retries, certain test scenarios.
   `declineCodeToCopy(null)` returns the fallback bucket.
2. **Decline code changes between retries.** We always overwrite
   `last_decline_code` with the latest webhook's value. T2 and T3 read
   the column at send time, so they see the most recent reason. If a
   bank says `insufficient_funds` on attempt 1 and `do_not_honor` on
   attempt 2, T2 says "your bank declined" — correct, that's what the
   bank said most recently.
3. **Spec 33 retry events.** `processPaymentFailed` already runs on
   every retry (Spec 33 lifted the attempt-count guard). We just add
   one column to the upsert. No new control flow.
4. **Customer updates card mid-sequence.** Existing
   `processPaymentSucceeded` path is unchanged. The recovery row gets
   created as today. We don't clear `last_decline_code` on recovery —
   keeping it lets us correlate "what was the failure reason" with
   "what the customer did" in analytics later. Harmless to keep.
5. **Same-message-body churn between T1 and T3.** All three reads from
   the same column. So if the bank's reason is consistent, T1+T2+T3
   tell a consistent story. If it changes, the latest is shown — which
   is what the customer should act on anyway.
6. **Translation / localisation.** English only for v1. The mapping
   table is a single TS file, so future localisation is mechanical
   (`reason: i18n[locale][bucket].reason`).
7. **Stripe adds a new decline code we don't know.** Falls through to
   the fallback bucket. We see it in `last_decline_code` on the row,
   notice via the dashboard later, add a row to the table when warranted.
8. **`suppressUpdateCta` and the email footer.** The footer (with the
   unsubscribe link) is unchanged. We're only conditionally suppressing
   the *body* update-payment line. The customer can still update via
   the email's footer or subsequent emails — we just don't bug them
   when Stripe is at fault.

---

## Out of scope (future)

- **Decline-code-aware *subject* lines.** Open-rate test once we have
  enough volume.
- **Surface `last_decline_code` on `/dashboard`** alongside the
  failed-payment subscriber rows.
- **Decline-code-aware founder-handoff escalation.** High-MRR + persistent
  `do_not_honor` could justify automated founder alert. Separate spec.
- **Live `last_payment_error.message` passthrough.** Stripe's raw bank
  message ("Card declined: 14") is often confusing or unhelpful. We
  prefer our curated copy. Skip.
- **Per-merchant decline-copy overrides** in `/settings`.
- **Localised decline copy** for non-English customers.

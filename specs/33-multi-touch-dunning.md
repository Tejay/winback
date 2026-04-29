# Spec 33 — Multi-touch dunning sequence (3 touches, retry-aware)

**Phase:** Pre-launch hardening
**Depends on:** Spec 09 (payment-failed flow), Spec 28 (email idempotency), Spec 30 (cron pattern + helper extraction)
**Estimated time:** ~5 hours

---

## Context

Today's card-save / dunning flow is **one email at the moment of first
failure, then radio silence** while Stripe Smart Retries pings the customer's
card up to 3 more times over ~3 weeks. Specifically:

- `app/api/stripe/webhook/route.ts` early-returns when
  `invoice.attempt_count > 1`, so subsequent retry events are ignored.
- The webhook **does** capture `invoice.next_payment_attempt` (line ~647) —
  the unix timestamp Stripe will retry next — and passes it into the email
  body. But it's **immediately discarded after sending**: never persisted to
  `wb_churned_subscribers`, never used to time follow-ups.
- There is no dunning-specific cron. The existing `reengagement` cron
  (Spec 28) targets win-back, and `onboarding-followup` (Spec 30) targets
  stuck signups.

So we touch the customer at one moment in a multi-week recovery window, and
sit on our hands for the remaining ~95% of it. Stripe retries the broken card
2–3 more times in the dark, with no nudge from us between attempts.

This spec turns that single shot into a **3-touch sequence timed against
Stripe's own retry schedule**:

```
Day 0   Stripe attempt #1 fails (initial)    → T1 sent immediately (existing)
Day ~2  24h before Stripe attempt #2          → T2 sent by cron
Day ~3  Stripe attempt #2 fires               → succeed = recover, fail = continue
Day ~15 24h before Stripe attempt #4 (final) → T3 sent by cron
Day ~16 Stripe attempt #4                     → succeed or subscription dies
        → win-back system (Spec 04) takes over from here
```

Three emails, deliberately spaced to **lead** Stripe's retries, never
duplicate them. Every retry the customer's card hits is preceded by ~24h of
nudge with a clear update-payment link.

---

## Goals

| # | Goal | Mechanism |
|---|------|-----------|
| 1 | Send a follow-up email ~24h before Stripe's next retry attempt | Persist `next_payment_attempt_at` on the subscriber row; daily cron picks up rows whose retry is in the next 12–36h window |
| 2 | Mark the **final** retry distinctly so T3 can use urgency copy | Webhook detects `attempt_count >= 3` and sets `dunning_state = 'final_retry_pending'` |
| 3 | Stop touching the subscriber when Stripe gives up or recovery happens | Webhook clears state on `payment_succeeded` and on `next_payment_attempt: null` |
| 4 | Idempotent at-most-once per touch type | `dunning_touch_count` integer on the row + the existing `wb_emails_sent` partial-unique-index pattern from Spec 28, with new types `dunning_t2` / `dunning_t3` |
| 5 | Hand off cleanly to win-back when Stripe gives up | `dunning_state = 'churned_during_dunning'`; existing Spec 04 win-back picks up via `customer.subscription.deleted` (unchanged) |

---

## Non-goals

- **Decline-code-aware action coaching** in T1/T2/T3 bodies. This is a real
  conversion lift but a separate, rule-based change that doesn't depend on
  this state machine. **Ships as Spec 34** on top of this.
- **AI-drafted founder-handoff escalation** for high-MRR card-save failures.
  Spec 21's handoff is win-back-specific; extending it to dunning is a future
  spec, not this one.
- **Pre-emptive "card expires soon"** emails via `invoice.upcoming`. Different
  trigger, different timing, different copy. Future spec.
- **Per-merchant dunning toggles** in `/settings`. The existing pause-all and
  AI-pause gates already give the merchant kill-switches; per-touch toggles
  add complexity without a clear ask.
- **Dunning-specific dashboard view** ("at-risk subscribers" tab). Existing
  dashboard "pending" filter is enough until we have data showing the dunning
  cohort needs its own surface.
- **Hourly cron**. Daily at 08:00 UTC with a generous 12–36h window is
  precise enough. Hourly would 30× the cron invocations for marginal gain.

---

## Detection (single SQL truth)

```sql
-- Eligible for T2: subscriber failed payment, hasn't been touched again,
-- Stripe will retry in the next 24h.
SELECT s.id, s.email, s.next_payment_attempt_at, c.product_name AS merchant
FROM   wb_churned_subscribers s
JOIN   wb_customers c ON c.id = s.customer_id
WHERE  s.dunning_state = 'awaiting_retry'
  AND  s.dunning_touch_count = 1
  AND  s.do_not_contact = false
  AND  s.next_payment_attempt_at BETWEEN now() + interval '12 hours'
                                     AND now() + interval '36 hours';

-- Eligible for T3: same shape, different state + count.
-- (state = 'final_retry_pending' AND dunning_touch_count = 2)
```

---

## Database — migration 028

```sql
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS next_payment_attempt_at  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dunning_touch_count      INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS dunning_last_touch_at    TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dunning_state            TEXT;

-- Partial index — only rows actively in the dunning sequence.
CREATE INDEX IF NOT EXISTS wb_churned_dunning_active_idx
  ON wb_churned_subscribers (next_payment_attempt_at)
  WHERE dunning_state IN ('awaiting_retry', 'final_retry_pending')
    AND dunning_touch_count < 3;
```

Drizzle: add the four columns to `churnedSubscribers` in
[lib/schema.ts](../lib/schema.ts).

`dunning_state` enum values:

| State | Meaning |
|---|---|
| `'awaiting_retry'` | Payment failed, more Stripe retries expected |
| `'final_retry_pending'` | Stripe is on attempt #3 of a default-4-attempt schedule; the next retry is the last |
| `'recovered_during_dunning'` | `payment_succeeded` fired during the dunning window |
| `'churned_during_dunning'` | Stripe sent `next_payment_attempt: null` (gave up); win-back picks up |

`dunning_touch_count` increments: 0 → 1 (T1 sent) → 2 (T2 sent) → 3 (T3 sent).

---

## Webhook changes

[app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts):

### `processPaymentFailed`

Currently early-returns when `invoice.attempt_count > 1`. **Lift that
restriction**. The handler now runs on every retry to keep state fresh.
Only the email-send fires once (on attempt #1 — existing).

```ts
const nextAttempt = invoice.next_payment_attempt
  ? new Date(invoice.next_payment_attempt * 1000)
  : null

const newDunningState = !nextAttempt
  ? 'churned_during_dunning'                  // Stripe gave up
  : invoice.attempt_count >= 3
  ? 'final_retry_pending'                     // next retry is the last
  : 'awaiting_retry'

// Existing subscriber upsert (unchanged) + new fields:
//   nextPaymentAttemptAt: nextAttempt
//   dunningState:         newDunningState
// On attempt_count == 1: also set dunningTouchCount = 1 + send T1 (existing).
// On subsequent failures: just refresh state, do NOT send another email
// (cron handles T2/T3).
```

### `processPaymentSucceeded`

Existing logic flips `status = 'recovered'` + creates a `wb_recoveries`
row. Add: when `dunning_state` is non-null, set
`dunning_state = 'recovered_during_dunning'`. The cron's eligibility
queries already filter on `dunning_state IN ('awaiting_retry',
'final_retry_pending')` so the recovered subscriber drops out naturally.

### `customer.subscription.deleted`

Existing handler marks the subscriber appropriately. Add: clear
`dunning_state` (set to `'churned_during_dunning'`) so the cron skips even
if `next_payment_attempt_at` is still set. Belt-and-braces.

---

## Cron route

`/api/cron/dunning-followup`, schedule `0 8 * * *` (daily 08:00 UTC,
offset from 09:00 reengagement and 09:30 onboarding-followup).

Standard pattern: `Bearer ${CRON_SECRET}` auth, `?dryRun=1` flag, returns
counts, delegates to `runDunningTouches({ dryRun })` in
`src/winback/lib/dunning-followup.ts` (mirrors Spec 30's
`onboarding-followup.ts` shape).

Add to [vercel.json](../vercel.json):
```json
{ "path": "/api/cron/dunning-followup", "schedule": "0 8 * * *" }
```

Helper does **two passes** in one function call:

### T2 pass — 24h before retry #2

```ts
where(and(
  eq(churnedSubscribers.dunningState, 'awaiting_retry'),
  eq(churnedSubscribers.dunningTouchCount, 1),
  eq(churnedSubscribers.doNotContact, false),
  isNotNull(churnedSubscribers.nextPaymentAttemptAt),
  // Generous 12-36h window so a missed daily run still catches it on
  // the next tick.
  sql`${churnedSubscribers.nextPaymentAttemptAt}
       BETWEEN now() + interval '12 hours'
           AND now() + interval '36 hours'`,
)).limit(100)
```

Per row:
1. **Re-check** suppressions in-loop: `status != 'recovered'`, customer
   not paused (`pausedAt IS NULL`), AI not paused (`aiPausedUntil`
   gate from Spec 22a).
2. `sendDunningFollowupEmail({ ..., isFinalRetry: false })`.
3. Atomic `INSERT INTO wb_emails_sent (subscriber_id, type='dunning_t2', ...)` —
   the partial unique index on `(subscriber_id, type)` from Spec 28
   ensures at-most-once delivery even on cron retries.
4. `UPDATE churned_subscribers SET dunning_touch_count = 2, dunning_last_touch_at = now()`.
5. `logEvent({ name: 'dunning_touch_sent', properties: { touch: 2, ... } })`.
6. Per-row try/catch; one failed send doesn't abort the loop.

### T3 pass — 24h before final retry

Identical shape; eligibility: `dunningState = 'final_retry_pending' AND
dunningTouchCount = 2`. Same time window. Sends with
`isFinalRetry: true`. Bumps to `dunningTouchCount = 3`. Logs
`{ touch: 3, isFinalRetry: true }`.

Both passes share the inner per-row logic via a small helper. Total cron
+ helper is ~150 lines.

---

## Email templates

One new function in [src/winback/lib/email.ts](../src/winback/lib/email.ts):

```ts
export async function sendDunningFollowupEmail(opts: {
  to:               string
  name:             string | null
  fromName:         string                // merchant founder/product name
  planName:         string
  amount:           string                // already formatted "29.00"
  currency:         string                // "GBP" / "USD"
  retryDate:        Date                  // next_payment_attempt
  subscriberId:     string                // for reply+ routing
  isFinalRetry:     boolean
}): Promise<{ messageId: string }>
```

Switches subject + body on `isFinalRetry`. Single function, two flavours.

### T2 (`isFinalRetry: false`)

Subject: `Heads up — we'll retry your card on {retryDate}`

```
Hi {name},

Quick reminder: your last payment to {fromName} for {planName}
({amount} {currency}) didn't go through, and we'll automatically try
your card again on {retryDate} at {retryTime}.

If you'd like to update your card or use a different payment method
before then:

{updatePaymentUrl}

If everything's already sorted, you can ignore this email — the next
retry will go through automatically.

— {fromName}
```

### T3 (`isFinalRetry: true`)

Subject: `Last automatic retry — your subscription ends {retryDate}`

```
Hi {name},

This is your last chance to update your payment before your
subscription with {fromName} ends.

We'll try your card one final time on {retryDate} at {retryTime}.
If it fails, your subscription will be cancelled and you'll lose
access to {planName}.

Update payment now:

{updatePaymentUrl}

If you've decided to leave, no need to reply — your subscription will
cancel on its own.

— {fromName}
```

Both:
- Sent from `${fromName} <reply+{subscriberId}@reply.winbackflow.co>` so
  customer replies route into the existing inbound webhook
- Wrapped in `callWithRetry` for 429 handling
- Use the standard footer (unsubscribe + reactivation links) via
  `appendStandardFooter`
- Use `wb_emails_sent` types `'dunning_t2'` and `'dunning_t3'` — these get
  added to the partial unique index in Spec 28 so re-cron retries can't
  double-send

---

## Tests

Pattern: `vi.hoisted` mocks of `@/lib/db`, `@/lib/schema`, `drizzle-orm` —
same shape as Spec 30's `onboarding-followup-cron.test.ts`.

**`src/winback/__tests__/dunning-state.test.ts`** (~6 tests, webhook):
- attempt_count=1 + retry scheduled → state='awaiting_retry', touch_count=1
- attempt_count=3 + retry scheduled → state='final_retry_pending'
- attempt_count=any + next_payment_attempt=null → state='churned_during_dunning'
- payment_succeeded after dunning → state='recovered_during_dunning'
- attempt_count>1 doesn't re-send T1 (idempotency)
- DNC subscriber doesn't get T1 (existing gate still works)

**`src/winback/__tests__/dunning-followup-cron.test.ts`** (~8 tests):
- T2: skips when touch_count != 1
- T2: skips when state != 'awaiting_retry'
- T2: skips when next_payment_attempt outside 12-36h window
- T2: writes touch_count=2 + last_touch_at after send
- T2: continues loop on per-row send failure
- T3: only fires for state='final_retry_pending' + touch_count=2
- T3: passes isFinalRetry=true to the email function
- Both: respect dryRun (no send, no DB write)

**`src/winback/__tests__/dunning-emails.test.ts`** (~4 tests):
- T2 subject contains "retry your card on"
- T3 subject contains "Last automatic retry"
- T3 body sets the urgency copy ("subscription ends", "final time")
- Both bodies include `${NEXT_PUBLIC_APP_URL}/api/update-payment/{id}`

Update `events.test.ts` whitelist if it filters names: add
`dunning_touch_sent`.

---

## Verification before merge

Per CLAUDE.md merge discipline:

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green
- [ ] Migration 028 applied to Neon (show SQL, wait for "yes")
- [ ] **End-to-end via dev test harness:**
  - Trigger a `payment_failed` via `/test/winback-flow`
  - Confirm: `wb_churned_subscribers` row has `dunning_state='awaiting_retry'`,
    `dunning_touch_count=1`, `next_payment_attempt_at` set, T1 in `wb_emails_sent`
  - Backdate `next_payment_attempt_at` to ~24h from now in psql
  - Hit cron with `?dryRun=1` → confirm 1 row eligible, no send
  - Hit cron without dryRun → confirm T2 sent (Resend dashboard +
    `wb_emails_sent` row with `type='dunning_t2'`), `dunning_touch_count=2`,
    `dunning_touch_sent` event in `wb_events`
  - Trigger another `payment_failed` with `attempt_count=3` → confirm
    `dunning_state='final_retry_pending'`
  - Backdate `next_payment_attempt_at` again, hit cron → T3 sent,
    `dunning_touch_count=3`, urgency copy in the email body
  - Trigger `payment_succeeded` → confirm `dunning_state='recovered_during_dunning'`
    + recovery row created (existing logic)
- [ ] PR opens with explicit migration callout, human says "merge"

---

## Edge cases handled

1. **Race: customer updates card between T2 and Stripe's retry.** Retry
   succeeds → `payment_succeeded` fires → existing recovery flow runs →
   `dunning_state='recovered_during_dunning'` → cron skips T3. Correct.
2. **Stripe retries faster than expected** (some merchants tune retry
   intervals shorter). The 12–36h window is generous; if the actual gap
   between `payment_failed` and the retry is < 12h, the daily cron misses
   it and we lose the touch. Acceptable v1; if it ever becomes a real
   issue, swap to hourly cron without schema changes.
3. **Customer cancels manually mid-dunning.**
   `customer.subscription.deleted` fires → existing handler runs + we
   set `dunning_state='churned_during_dunning'`. Cron stops. Win-back
   spec 04 takes over via the cancellation path.
4. **Multiple subscriptions per customer, one fails another succeeds.**
   Each subscription has its own `wb_churned_subscribers` row keyed by
   subscription ID. Independent state machines, no cross-contamination.
5. **Stripe's `attempt_count` semantics.** Default Smart Retries does
   **4 total attempts**; `attempt_count=1` is the first failure,
   increments on each retry. Code uses `attempt_count >= 3 →
   final_retry_pending` which is correct for the default. Merchants who
   customised retry count get a slightly mistimed T3 but no broken
   behaviour. Not worth reading per-merchant retry config.
6. **Founder-handoff already fired (Spec 21).** Handoff is for
   voluntary win-back, dunning is involuntary. They can coexist; if a
   founder is hand-deciding the win-back conversation while the card is
   also failing, both flows run. Dunning is automatic and short-lived;
   handoff is human and slow. No conflict.
7. **Test-mode merchants with no real retry schedule.** In Stripe test
   mode `next_payment_attempt` is still set. Behaviour is identical to
   live mode for our purposes.

---

## Out of scope (becomes Spec 34+)

- **Spec 34 (planned next):** Decline-code-aware action coaching in T1/T2/T3 bodies.
  Rule-based switch on `invoice.last_payment_error.decline_code` →
  per-reason next-step language. Big copy uplift, no LLM, ~half a day.
- AI-drafted founder-handoff escalation for high-MRR dunning.
- Pre-emptive `invoice.upcoming` "card expires soon" pings.
- Dunning-specific `/dashboard` filter ("at-risk subscribers").
- Per-merchant dunning toggles in `/settings`.
- Hourly cron (only revisit if 12–36h window proves insufficient).

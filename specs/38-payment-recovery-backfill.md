# Spec 38 — Past-due / unpaid backfill on first connect (3-month cancellation window)

**Phase:** Pre-launch hardening / "fastest time to first recovery"
**Depends on:** Spec 09 (T1 dunning email), Spec 33 (T2/T3 multi-touch),
Spec 34 (decline-code-aware copy), existing 1-year cancellation
backfill in `src/winback/lib/backfill.ts`
**Estimated time:** ~half a day + tests

---

## Context

When a merchant connects Stripe today, the OAuth callback fires
`backfillCancellations` (`src/winback/lib/backfill.ts`) in the
background. That backfill pulls **only `status: 'canceled'`
subscriptions** from the last year — and emails the cohort cancelled
within the last 7 days.

**What it doesn't pull**: subscriptions in `past_due` or `unpaid`
state right now. These are subscribers whose card just failed and
Stripe is mid-retry. They are the **highest-recoverability cohort**
on the platform — the customer wants to stay; the card just broke;
recovery typically lands within hours of the right email.

Today they are invisible to Winback until the *next*
`invoice.payment_failed` webhook fires from Stripe — which can be
1–4 days away depending on where in the retry schedule we land. So a
merchant who connects in the morning may see *nothing happen* for
days, even though there are recoverable customers waiting.

This is the biggest gap in "fastest time to first recovery."

We close that gap and tighten the cancellation window from 1 year →
3 months at the same time. Cancellations 3+ months old are virtually
unrecoverable from a cold email and add only noise to the dashboard.

## Goals

- **First payment recovery in hours, not days.** T1 dunning email
  fires within minutes of OAuth completion (background) for past-due
  subs that haven't been touched yet.
- **Reduce noise.** Cancellation backfill window 1 year → 3 months.
- **No new infra.** No new tables, queues, crons, or external
  services. The existing `/api/cron/dunning-followup` (daily 08:00
  UTC) handles T2/T3 for backfilled rows naturally.
- **Idempotent.** Replaying the backfill or webhook for the same
  subscription must never double-send or double-bill.

## Non-goals

- **First-paint MRR snapshot.** Showing "Watching N subs · $X/mo MRR"
  on the empty dashboard. Cost/value too low; the empty-then-fills
  experience is fine for a 30-second window. Drop.
- **Sender warm-up pacing.** Spreading sends to defend domain
  reputation is a cross-cutting concern (also affects live
  cancellations); separate spec.
- **Sub-60-second T1.** The system can take its time in the
  background. What matters is the recovery, which lands hours after
  T1 regardless of whether T1 was sent at second 30 or minute 5.
- **`paid` invoice lookback** (i.e. retroactively counting last
  week's organic recoveries). Stripe handles its own attribution; we
  only act on currently-failing invoices.
- **Retroactive backfill for existing merchants.** Spec applies to
  fresh connects. A separate one-shot script can run for existing
  active customers if/when needed.

## What changes

### A. New shared helper — `src/winback/lib/payment-recovery.ts`

Extract the dunning-row-create + T1-send logic out of
`processPaymentFailed` (currently inline at
`app/api/stripe/webhook/route.ts:557–765`) into:

```ts
export async function processPaymentRecovery(input: {
  customerId: string
  stripeCustomerId: string
  stripeSubscriptionId: string
  invoice: Stripe.Invoice              // latest failing invoice
  source: 'webhook' | 'backfill'
  forceTouchCount?: 1 | 2               // backfill-only override
  stripeCustomerEmail?: string | null   // skip lookup if caller has it
  stripeCustomerName?: string | null
  paymentMethodId?: string | null
  fromName: string                      // resolved by caller
}): Promise<{ inserted: boolean; emailed: boolean; subscriberId: string | null }>
```

Behaviour mirrors the current webhook flow:

1. Derive `dunningState`, `lastDeclineCode`, `nextRetryDate` from the
   invoice — same logic as `webhook/route.ts:565–590`.
2. Find existing `(customerId, stripeCustomerId, cancellationReason='Payment failed')` row.
3. If row exists with a `dunning` email already sent → refresh state, return `emailed: false`.
4. If row exists but no email yet → use existing row, send T1.
5. If no row → insert new row with the appropriate `dunningTouchCount` and `dunningState`.
6. **Backfill-only branch**: when `forceTouchCount` is set, **skip the T1 send** and insert/update at the requested touch count. Used for backfilled rows already mid-retry on Stripe (attempt_count >= 2) so the existing daily cron picks them up for T2/T3.
7. **Sanity check**: skip T1 send when `invoice.status !== 'open'`. Customer may have already fixed the card via Stripe portal between connect and our processing; emailing them would be wrong.

Both `processPaymentFailed` (webhook path) and `backfillPaymentRecovery`
(new) call this helper.

### B. New backfill function — `src/winback/lib/backfill.ts`

Add:

```ts
export async function backfillPaymentRecovery(
  customerId: string,
): Promise<{ found: number; contacted: number; skipped: number }>
```

Steps:

1. Resolve customer + decrypt access token (same setup as
   `backfillCancellations`).
2. Paginate `stripe.subscriptions.list({ status: 'past_due', limit: 100, expand: ['data.latest_invoice', 'data.customer'] })`.
3. Repeat for `status: 'unpaid'`.
4. Hard cap **500 subs per status** (1000 total) — log
   `payment_recovery_backfill_truncated` event and stop. Realistic
   merchant has <50.
5. For each subscription, compute action from `latest_invoice.attempt_count` and `next_payment_attempt`:

| Stripe state | Backfill action | Touch count | dunningState |
|---|---|---|---|
| `attempt_count <= 1` (or null) | T1 sent now | 1 | `awaiting_retry` |
| `attempt_count === 2` | No email; cron picks up T2 next tick | 1 | `awaiting_retry` |
| `attempt_count >= 3` | No email; cron picks up T3 next tick | 2 | `final_retry_pending` |
| `next_payment_attempt === null` (sub `unpaid`, Stripe gave up) | T1 sent now | 1 | `churned_during_dunning` |

6. Per-row try/catch — one bad row must not abort the loop.
7. Sequence with cancellation backfill: **payment-recovery first**
   (smaller cohort, higher leverage, finishes faster), then
   `backfillCancellations`. Don't parallelise — both paths update
   `customers.backfillProcessed`.
8. Email pacing: **synchronous in-loop** sends. Dunning emails are
   template-based (no LLM call) so each send is ~300–500 ms; 50 subs
   complete in 15–25 seconds. Backfill is background so the merchant
   never sees the loop block.

### C. Cancellation backfill window — 1 year → 3 months

In `src/winback/lib/backfill.ts`:

- Replace `ONE_YEAR_MS` (line 11) with
  `THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000`.
- Update local variable `oneYearAgo` (line 86) → `cutoff`.
- Update the inner-loop comparison (line 116).
- 7-day email window inside the loop is **unchanged**.

No other behaviour changes. Existing tests must continue to pass; we
adjust only test fixtures that depended on the 1-year window.

### D. Wire-up — `app/api/backfill/start/route.ts`

Change the call from:

```ts
await backfillCancellations(customerId)
```

To (in order):

```ts
await backfillPaymentRecovery(customerId)
await backfillCancellations(customerId)
```

Sequence matters: payment-recovery first.

### E. Status endpoint — `app/api/backfill/status/route.ts`

Extend the GET response with three new fields:

```ts
paymentRecoveryFound: number       // count of churned_subscribers where source='backfill_dunning'
paymentRecoveryContacted: number   // joined with emailsSent type='dunning'
paymentRecoveryMrrCents: number    // sum of mrrCents on those rows
```

These come from a second aggregate query against `churned_subscribers`
filtered by `source = 'backfill_dunning'`. Cheap — runs once per
3-second poll.

### F. Dashboard banner — `app/dashboard/dashboard-client.tsx` (~line 286–334)

When `paymentRecoveryFound > 0`, render a two-line layout:

**In progress:**
> Recovering **N** customers with failed payments — emails going out now.<br/>
> Plus reviewing **M** cancellations from the last 3 months.

**Complete:**
> Recovering **N** customers (\$X/mo at risk) and reviewing **M** cancellations (\$Y/mo lost).

Distinct visual emphasis on the payment-recovery line (it's the
time-sensitive, high-recoverability cohort). When
`paymentRecoveryFound === 0`, banner falls back to the existing
single-line cancellation copy unchanged.

### G. Refactor `processPaymentFailed`

In `app/api/stripe/webhook/route.ts:557–765`, replace the inline
implementation with a single call:

```ts
async function processPaymentFailed(event: Stripe.Event) {
  // …minimal preamble: resolve customer + email + fromName…
  await processPaymentRecovery({
    customerId,
    stripeCustomerId,
    stripeSubscriptionId,
    invoice,
    source: 'webhook',
    stripeCustomerEmail: stripeCustomer.email,
    stripeCustomerName: stripeCustomer.name ?? null,
    paymentMethodId,
    fromName,
  })
}
```

Behaviour identical to today. Existing tests must continue to pass
with no fixture changes.

## Code paths touched

| Path | Change |
|---|---|
| `specs/38-payment-recovery-backfill.md` | **new** (this file) |
| `src/winback/lib/payment-recovery.ts` | **new** — shared helper |
| `src/winback/lib/backfill.ts` | add `backfillPaymentRecovery`; window 1y → 3mo |
| `app/api/backfill/start/route.ts` | call payment-recovery before cancellations |
| `app/api/backfill/status/route.ts` | 3 new aggregate fields |
| `app/api/stripe/webhook/route.ts` | refactor `processPaymentFailed` to delegate |
| `app/dashboard/dashboard-client.tsx` | banner copy + 2-line layout |
| `lib/schema.ts` | document `'backfill_dunning'` as a valid `source` value (the column is free-text; no migration required) |
| `src/winback/__tests__/payment-recovery-backfill.test.ts` | **new** test suite |

## Edge cases

1. **Webhook fires during backfill for the same sub.** Both call the
   shared helper; first call inserts the row + sends T1; second call
   sees existing row + email and refreshes state only. No
   duplicates.
2. **Customer fixes card via Stripe portal between connect and our
   send.** Sanity check: `invoice.status === 'paid'` → skip T1.
3. **Multi-currency / metered billing.** Use `invoice.amount_due`
   directly (matches existing webhook). `mrrCents` may be 0 for pure
   metered subs — still email.
4. **Subscription has `latest_invoice` but no `subscription` field
   set.** Skip — defensive; same logic as webhook line 563.
5. **500-sub cap reached.** Log + stop. Realistic case is <50.
6. **Empty cohort.** Return zero counts; banner falls back to
   single-line cancellation copy.
7. **Concurrent backfill + cancellation backfill.** Sequenced
   (payment-recovery first), not parallel — both update
   `customers.backfillProcessed`.
8. **Re-running `/api/backfill/start` on a customer who already
   completed backfill.** Idempotent: existing rows skip; no
   duplicate emails (existing partial unique index on
   `wb_emails_sent (subscriber_id, type)` from migration 028
   guarantees this).

## Tests — `src/winback/__tests__/payment-recovery-backfill.test.ts`

Style matches `dunning-followup-cron.test.ts` (mocked Stripe + DB).

Cases:

- `attempt_count === 1` → row at touch=1, T1 sent, `awaiting_retry`
- `attempt_count === 2` → row at touch=1, **no T1**, `awaiting_retry`
- `attempt_count === 3` → row at touch=2, no email, `final_retry_pending`
- `next_payment_attempt === null` → `churned_during_dunning`, T1 sent
- Existing `(customerId, stripeCustomerId, 'Payment failed')` row → no-op, no double-insert
- Existing row with `emailsSent type='dunning'` → no double-send
- 500-sub cap → log + stop, returns truncated count
- Empty results → `{ found: 0, contacted: 0, skipped: 0 }`
- Webhook-then-backfill collision → backfill skips on existing row
- Backfill-then-webhook collision → webhook updates state via existing else-branch
- Sanity check: `invoice.status === 'paid'` → no T1, no row inserted

Plus assertion in any existing `/api/backfill/status` integration
test for the 3 new fields. Existing
`backfill.test.ts`/`dunning-*.test.ts` suites must continue to pass
unchanged.

## Verification

End-to-end on a Stripe sandbox account:

- [ ] Connect with one `past_due` (attempt 1) sub → T1 lands within
      minutes; row in DB with `source='backfill_dunning'`,
      `dunningTouchCount=1`, `dunningState='awaiting_retry'`.
- [ ] Connect with one `past_due` (attempt 2) sub → no email
      immediately; row at `dunningTouchCount=1`. Wait for next 08:00
      UTC cron tick → T2 fires.
- [ ] Connect with one `unpaid` (no `next_payment_attempt`) sub → T1
      lands; `dunningState='churned_during_dunning'`.
- [ ] Re-run `/api/backfill/start` for same merchant → no duplicate
      rows, no duplicate emails (verify via `wb_emails_sent` count).
- [ ] Connect, then Stripe fires `invoice.payment_failed` for an
      already-backfilled sub → state refreshes (existing else-branch
      logic), no duplicate T1.
- [ ] Dashboard banner during backfill: poll shows
      `paymentRecoveryFound` climbing; final state shows two-line
      copy.
- [ ] Dashboard banner with zero past-due subs: falls back to single-
      line cancellation copy unchanged (regression).
- [ ] Cancellation backfill: only last 90 days pulled (verify a
      120-day-old `canceled` sub does *not* appear in DB after
      backfill).
- [ ] Cancellation backfill emails <7 day cohort and skips 7+ day
      cohort (regression).
- [ ] Live `invoice.payment_failed` webhook still works exactly as
      before (regression — `processPaymentFailed` now delegates to
      shared helper).
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx vitest run` — all existing 462+ tests pass plus new suite.

## Out of scope (future)

- **Retroactive backfill for existing merchants.** A one-shot script
  for already-connected accounts; spec separately if/when needed.
- **First-paint MRR snapshot.** Explicitly dropped — see Non-goals.
- **Sender warm-up pacing.** Cross-cutting; separate spec.
- **CLAUDE.md update.** Internal doc — refresh next time it's touched.

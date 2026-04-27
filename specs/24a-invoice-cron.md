# Spec 24a — Phase 9.2a: Monthly invoice cron

> **⚠️ Superseded (2026-04-27)** — the monthly cron + `wb_billing_runs`
> + `processBillingRun` flow described below was replaced by a recurring
> Stripe Subscription on the platform Stripe customer. Stripe drives the
> cycle, dunning, and retries. Cron route, `billing.ts`, and
> `wb_billing_runs` table all deleted in PR #37. Win-back fees are now
> attached as one-off Stripe invoice items via `performance-fee.ts`.

**Phase:** Next up (April 2026)
**Depends on:** Spec 23 (card capture), `src/winback/lib/billing.ts`, `src/winback/lib/obligations.ts`
**Unblocks:** Phase 9.2b (invoice display), Phase 9.3 (dunning)

---

## Summary

Monthly cron that creates + finalizes Stripe invoices on the platform
account, charging customers 15% × MRR for each still-active billable
recovery. Runs on the 1st of each month UTC and bills in arrears
(invoice dated June 1 covers recoveries active during May).

**Scope**: cron + invoice creation + webhook reconciliation. No UI
(that's 24b). No dunning (that's 25).

---

## Context

`calculateMonthlyFee()` in `src/winback/lib/billing.ts` already computes
the math. `wb_settlement_requests` handles one-time settlement at
workspace deletion but does nothing for ongoing monthly billing. Spec 23
captured the card on file. Now we need to actually charge it.

---

## Design

### Billing model decisions (confirmed)

1. **Billing date**: 1st of each month, midnight UTC. Same day for everyone — predictable, clean.
2. **Billing period**: in arrears. Invoice on June 1st covers recoveries active during May.
3. **First invoice timing**: waits for the next 1st-of-month cron. No prorated first invoice.
4. **Line items**: one per still-active billable recovery. Each = `round(0.15 × recovery.planMrrCents)`.
5. **Customer with no card yet**: still tracked; cron skips them (can't bill). When they add card later, cron starts billing them on the next 1st. Months before card capture are not retroactively charged.
6. **Idempotency**: `wb_billing_runs` table with `UNIQUE(customer_id, period_yyyymm)`.

### Schema

```sql
-- migration 016_billing_runs.sql
CREATE TABLE wb_billing_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES wb_customers(id) ON DELETE CASCADE,
  period_yyyymm     text NOT NULL,  -- '2026-05' (period COVERED, not invoice date)
  stripe_invoice_id text,
  amount_cents      integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'pending',  -- 'pending' | 'paid' | 'failed' | 'skipped_no_obligations' | 'skipped_no_card'
  line_item_count   integer NOT NULL DEFAULT 0,
  created_at        timestamptz DEFAULT now(),
  finalized_at      timestamptz,
  paid_at           timestamptz,
  UNIQUE (customer_id, period_yyyymm)
);
```

### Cron flow

```
0 0 1 * *  →  GET /api/cron/billing (Authorization: Bearer CRON_SECRET)

const period = previousMonthYYYYMM(now)  // e.g., "2026-05" when running on June 1

for each customer (with stripe_platform_customer_id OR has open obligations):
  if billing_run exists for (customer.id, period) → skip (already billed)

  if no stripe_platform_customer_id → insert 'skipped_no_card' run, continue

  const fee = await calculateMonthlyFee(customer.id)  // from billing.ts
  if fee.totalCents === 0 → insert 'skipped_no_obligations' run, continue

  // Create billing_run row early (reserves the period slot via unique constraint)
  const [run] = insert wb_billing_runs { customer_id, period_yyyymm: period, status: 'pending', amount_cents: 0, line_item_count: fee.lineItems.length }

  // Create invoice items (one per recovery)
  for lineItem of fee.lineItems:
    stripe.invoiceItems.create({
      customer: platformCustomerId,
      amount: lineItem.feeCents,
      currency: 'usd',
      description: `Recovered: ${lineItem.subscriberEmail} — $${lineItem.mrr/100}/mo (15%)`,
      metadata: { winback_customer_id, winback_recovery_id: lineItem.recoveryId },
    })

  // Create and finalize invoice (auto-pays on default PM)
  const invoice = await stripe.invoices.create({
    customer: platformCustomerId,
    auto_advance: true,  // auto-finalize + attempt payment
    collection_method: 'charge_automatically',
    description: `Winback success fees — ${humanPeriod(period)}`,
    metadata: {
      winback_customer_id,
      winback_billing_run_id: run.id,
      period_yyyymm: period,
    },
  })

  update wb_billing_runs
    set stripe_invoice_id = invoice.id,
        amount_cents      = invoice.amount_due,
        finalized_at      = now()
    where id = run.id

  logEvent({ name: 'billing_invoice_created', customerId, properties: { runId, invoiceId, amountCents } })

return { processed, created, skipped, errors }
```

### Vercel cron

```json
// vercel.json
{
  "crons": [
    { "path": "/api/cron/reengagement", "schedule": "0 9 * * *" },
    { "path": "/api/cron/billing",      "schedule": "0 0 1 * *" }
  ]
}
```

Monthly at 00:00 UTC on the 1st. Requires Vercel Pro plan (Hobby only
supports daily). Cron uses `CRON_SECRET` bearer token (same pattern as
reengagement cron).

### Webhook reconciliation

`invoice.paid` and `invoice.payment_failed` on the platform account now
flow to a new handler. Differentiate from existing Connect-account
handlers by checking `event.account`:

```ts
// existing handlers (processPaymentSucceeded, processPaymentFailed) already
// return early when !event.account. We add a parallel platform branch.
if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
  if (!event.account) {
    await processPlatformInvoiceEvent(event)
  }
}
```

`processPlatformInvoiceEvent`:
1. Extract `stripe_invoice_id` from the event
2. Look up the `wb_billing_runs` row by `stripe_invoice_id`
3. Update `status` + `paid_at` accordingly
4. Log `billing_invoice_paid` or `billing_invoice_failed`

Note: `invoice.payment_failed` here just records the first failure. Retry
logic + customer notification = spec 25 (dunning).

### Error handling

- **Cron errors per customer**: wrap each customer's billing in try/catch.
  Log error with customer ID. Continue with next customer. Don't let one
  customer's Stripe error fail the whole run.
- **Race on unique constraint**: if two cron invocations (retry?) try to
  insert the same (customer_id, period) — one wins, the other's insert
  fails. We catch the unique violation and treat as "already billed,
  skip."
- **Invoice creation fails mid-way**: `billing_run` row exists with
  `status='pending'` but no `stripe_invoice_id`. On next cron run or
  manual trigger, we could retry those — but for v1, we just log and move
  on. Manual recovery via script.
- **No default payment method**: Stripe will still create the invoice but
  payment will fail immediately. Webhook catches it → status='failed'.
  Spec 25 handles the customer communication.

### Observability

New `wb_events` rows:
- `billing_invoice_created` — `{ billingRunId, stripeInvoiceId, amountCents, lineItemCount, period }`
- `billing_invoice_paid` — `{ billingRunId, stripeInvoiceId, amountCents }`
- `billing_invoice_failed` — `{ billingRunId, stripeInvoiceId, failureReason }`
- `billing_cron_complete` — `{ processed, created, skipped, errors }`

---

## Files

### New
- `src/winback/migrations/016_billing_runs.sql` — `wb_billing_runs` table
- `app/api/cron/billing/route.ts` — the monthly cron handler
- `src/winback/lib/platform-billing.ts` — extend with `createMonthlyInvoice()` + helpers
- `src/winback/__tests__/billing-cron.test.ts` — unit tests

### Modified
- `lib/schema.ts` — add `billingRuns` table + type
- `vercel.json` — add cron schedule
- `app/api/stripe/webhook/route.ts` — route platform invoice events → `processPlatformInvoiceEvent`

### Reused
- `calculateMonthlyFee()` from `src/winback/lib/billing.ts`
- `getPlatformStripe()` from `src/winback/lib/platform-stripe.ts`
- `logEvent()` from `src/winback/lib/events.ts`

### Env vars
None new. `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CRON_SECRET` already set.

---

## Verification

### Unit
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — new `billing-cron.test.ts` covers:
  - Period computation (`previousMonthYYYYMM` on various dates incl. Jan 1 → "2025-12")
  - Idempotency: two runs on same period → second skipped
  - Fee calculation: matches `calculateMonthlyFee` output
  - Skip reasons: no card, no obligations
- [ ] Migration 016 applied; `wb_billing_runs` table + unique constraint present

### Manual end-to-end (Stripe test mode)
- [ ] Seed a test customer with 1+ billable recovery via DB or test harness
- [ ] Add card via Settings (spec 23 flow)
- [ ] Hit `/api/cron/billing` with `Authorization: Bearer $CRON_SECRET`
- [ ] Check DB: `wb_billing_runs` row for the previous period, status progresses pending → paid (webhook)
- [ ] Check Stripe dashboard: draft invoice finalized, paid automatically from default PM
- [ ] `wb_events` has `billing_invoice_created` + `billing_invoice_paid`
- [ ] Re-run cron — second run inserts `skipped` because unique constraint blocks duplicate
- [ ] Customer without card: run recorded as `skipped_no_card`
- [ ] Customer with no billable recoveries: run recorded as `skipped_no_obligations`

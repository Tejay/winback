> **⚠️ Historical reference — pricing model was rewritten on 2026-05-23.**
> The "$99/mo + 1× MRR per recovery" and "14-day refund window" mechanics
> described in this doc no longer exist. Current model: tiered flat
> monthly fee priced by the customer's own MRR (Starter $99 / Growth
> $299 / Scale $699 / Enterprise sales-handled), no per-recovery
> charges, no refund windows. See `CLAUDE.md` and
> `/Users/tejay/.claude/plans/we-are-going-to-memoized-kernighan.md`
> for the current model. This doc is preserved as historical record.

# Spec 61 — Stripe API: `invoice.lines.data[].invoice_item` field migration

## Context

Tier 3.2 (refund within 14-day window) showed the DB-side refund
records as successful (`perf_fee_refunded_at` set), but **Stripe
never issues the credit note**. The merchant remains charged.

Same class of bug as Spec 57: the new Stripe API restructured a
nested field, and our code still reads the old path.

Specifically, `refundPerformanceFee` looks up the line on the invoice
that corresponds to the perf-fee invoice item, so it can create a
credit note against that line:

```ts
// app/api/... actually src/winback/lib/performance-fee.ts:315
const line = invoice.lines.data.find(
  (l) => (l as Stripe.InvoiceLineItem & { invoice_item?: string }).invoice_item ===
    rec.perfFeeStripeItemId,
)
if (!line) {
  // log win_back_refund_line_missing event for manual reconciliation
  method = 'line_not_found'
} else {
  await stripe.creditNotes.create({...})
  method = 'credit_note'
}
```

On API ≥ 2024-09-30 (current default 2026-03-25), `line.invoice_item`
is **undefined**. The reference moved to:

```
invoice.lines.data[].parent.invoice_item_details.invoice_item
```

Verified empirically against `in_1TWCSIAt1bwzP4uUl1lnygiK`:

```
line.invoice_item                                          → undefined
line.parent.type                                           → 'invoice_item_details'
line.parent.invoice_item_details.invoice_item              → 'ii_1TWCSGAt1bwzP4uUcJTsQRHW' ✓
```

The function falls into the `line_not_found` graceful-degradation
branch on every refund. The DB write proceeds, the event is logged,
the merchant gets no refund.

**Impact in production:** every subscriber re-cancel within the
14-day refund window. Merchant's Stripe invoice keeps the $50 (or
1× MRR) charge. The Winback dashboard shows the recovery as
refunded. Our books and Stripe's books disagree. Silently.

## Goals

- `refundPerformanceFee` correctly identifies the invoice line for
  any perf-fee invoice item on the new API shape, falls back to the
  legacy shape for old replayed events.
- `creditNotes.create` succeeds against a *paid* invoice on the new
  API. Spec 61's first fix surfaced a second issue: the API now
  requires the credit note's total to equal the sum of
  `refund_amount + credit_amount + out_of_band_amount`. Our current
  call passes none, so the API errors with
  `"The sum of refunds, credit amount, and out of band amount ($0.00)
  must equal the credit note post_payment_amount ($50.00)"`. We pass
  `refund_amount = perf-fee amount` so Stripe creates a real refund
  back to the merchant's card as part of the credit note (the natural
  semantic for "the subscriber didn't stick, give the merchant their
  perf fee back").
- Re-run Tier 3.2 e2e: credit note actually created on Stripe **and**
  refund issued; DB refund mark + Stripe credit note + Stripe refund
  all in sync.

## Non-goals

- No DB schema change.
- No change to the 14-day window, refund eligibility logic, or the
  delete-item branch (those are intact).
- No fix for `item.invoice` access in the same file — empirically
  that's still working on the new API. (Will be picked up by the
  follow-up "audit all Stripe field accesses" sweep already on the
  todo list.)

## Code paths touched

| File | Change |
|---|---|
| `src/winback/lib/stripe.ts` | NEW export `getInvoiceLineInvoiceItemId(line: unknown): string \| null` — reads `line.parent.invoice_item_details.invoice_item` with fallback to legacy `line.invoice_item`. Mirrors the Spec 57 helper pattern. |
| `src/winback/lib/performance-fee.ts` | Replace the inline `.invoice_item` cast with `getInvoiceLineInvoiceItemId(l)`. |
| `src/winback/__tests__/invoice-line-invoice-item-id.test.ts` | NEW — 4 cases: new shape, legacy shape, neither set, precedence (new wins when both present). Mirrors Spec 57's helper test. |
| `src/winback/__tests__/performance-fee.test.ts` (refund describe block) | Adjust the refund-via-credit-note test to use the new line shape in its mock invoice, plus a parallel case verifying legacy shape still works. |

## Helper implementation (illustrative)

```ts
// src/winback/lib/stripe.ts
export function getInvoiceLineInvoiceItemId(line: unknown): string | null {
  if (!line || typeof line !== 'object') return null
  const l = line as Record<string, unknown>

  // API ≥ 2024-09-30: line.parent.invoice_item_details.invoice_item
  const parent = l.parent as Record<string, unknown> | undefined
  const details = parent?.invoice_item_details as Record<string, unknown> | undefined
  const fromParent = details?.invoice_item
  if (typeof fromParent === 'string') return fromParent

  // Legacy: top-level line.invoice_item
  const legacy = l.invoice_item
  if (typeof legacy === 'string') return legacy

  return null
}
```

## Edge cases handled

1. **New API shape** (current default) — reads from
   `parent.invoice_item_details.invoice_item`.
2. **Legacy shape** — falls back to top-level `invoice_item`. Needed
   for replayed events and webhook endpoints pinned to older API
   versions.
3. **Subscription line (not perf-fee)** — line has
   `parent.type === 'subscription_item_details'` and no
   `invoice_item` field. Helper returns null. The `find` correctly
   returns no match and we move to the next line.
4. **Line.invoice_item present but as an expanded object** — legacy
   branch handles `typeof === 'string'`; expanded shape wasn't a
   thing for this field historically, so no need to handle. Return
   null safely.
5. **Replayed event from before the upgrade** — backwards compatible
   via the legacy fallback.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — new helper test + existing refund tests
- [ ] **E2E**: re-run `scripts/billing-test-tier3-2-refund-within-window.ts`
      and confirm:
  - `wb_recoveries.perf_fee_refunded_at` is set
  - **a credit note exists** on the perf-fee's invoice
  - the credit note amount matches the perf fee (5000 cents)

## Out of scope

- Audit of all other Stripe field accesses (existing todo).
- Stripe API version pinning (separate, broader discussion).
- Changes to the delete-item branch (it works correctly when invoice
  is `draft` or item is unattached).

## Why this matters

This is the second instance of "Stripe restructured an invoice field
and our code missed the migration" (first was Spec 57's
`invoice.subscription`). Both were silent failures of refund- or
recovery-critical paths. After this lands, the obvious next step is
**Stripe API version pin audit** (already on the todo list) — pinning
to a specific tested version freezes the contract and makes future
migrations explicit upgrades rather than silent regressions.

For now, fix the immediate bug; queue the audit.

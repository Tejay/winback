> **⚠️ Historical reference — pricing model was rewritten on 2026-05-23.**
> The "$99/mo + 1× MRR per recovery" and "14-day refund window" mechanics
> described in this doc no longer exist. Current model: tiered flat
> monthly fee priced by the customer's own MRR (Starter $99 / Growth
> $299 / Scale $699 / Enterprise sales-handled), no per-recovery
> charges, no refund windows. See `CLAUDE.md` and
> `/Users/tejay/.claude/plans/we-are-going-to-memoized-kernighan.md`
> for the current model. This doc is preserved as historical record.

# Spec 67 — Admin perf-fee refund button + invoice link

## Context

From the support-readiness audit (2026-05-14): the **P0** gap in our
admin tooling is the missing UI for refunding a 1× MRR performance
fee. The 14-day refund window is our headline guarantee ("refundable
in full if the subscriber re-cancels within 14 days"); requiring
support to drop into the Stripe Dashboard to action it is both
error-prone (no DB attribution update) and embarrassing once a real
customer asks for it.

Bundled with the **P2** invoice-link gap (#12 in the same audit) since
they share the same surface: `/admin/billing`. Both touch
`wb_recoveries` rows. Single PR.

The business logic is already done: `refundPerformanceFee(recoveryId)`
exists at [`src/winback/lib/performance-fee.ts:283`](src/winback/lib/performance-fee.ts:283),
handles all three branches (delete invoice item / credit note /
noop), and is idempotent on `perfFeeRefundedAt`. The work here is
exposing it as an admin action.

## Goals

- New "Charged win-back fees" section on `/admin/billing` listing the
  200 most recent charged fees (no time cut-off — admin should be able
  to refund any individual charge regardless of age), with status
  (charged / refunded / item-missing), refund button on each
  refundable row, and a "View in Stripe" link per row.
- Page-level customer filter — a single search input near the top of
  `/admin/billing` that does a case-insensitive substring match against
  product name / customer email and live-filters BOTH the Outstanding
  and Charged sections. Client-side only (operates on the already-
  fetched payload).
- New `POST /api/admin/billing/recoveries/[id]/refund` endpoint that:
  - Requires admin auth (existing `requireAdmin`)
  - Requires a typed `confirm` string ("REFUND") to gate accidental
    clicks
  - Calls `refundPerformanceFee(recoveryId)`
  - Writes `admin_action` event with action `perf_fee_refunded` and
    actor / customerId / recoveryId / Stripe method used
- "View in Stripe" link on every charged row (and refunded rows, for
  audit context) — opens the Stripe Dashboard's invoice-item page.

## Non-goals

- Refunding a **queued** fee that hasn't been charged yet. The existing
  outstanding-obligations section already shows these; they can be
  marked refunded only AFTER charging, per the existing data model.
  (Edge: support could mark a queued one "won't charge" via a future
  spec; out of scope here.)
- Partial refunds. We refund 1× MRR in full or not at all — matches
  the product promise.
- Refunding the $99/mo platform fee. That's a Stripe Subscription on
  Winback's own account; merchant uses Stripe's billing portal.
- Bulk refund. One row, one click. If we need bulk, separate spec.
- Auto-refund of fees outside the 14-day window. Spec policy is
  14-day; support can override manually (button enabled with warning),
  but no automation.

## Schema

**No migrations.** All fields used already exist on `wb_recoveries`:
- `perf_fee_charged_at` (filter for "recent charged")
- `perf_fee_refunded_at` (status toggle)
- `perf_fee_stripe_item_id` (Stripe link target)
- `perf_fee_amount_cents` (display)

## Code paths touched

### New endpoint

**`app/api/admin/billing/recoveries/[id]/refund/route.ts`**

```ts
POST { confirm: "REFUND" }
→ { ok: true, method: 'delete_item' | 'credit_note' | 'line_not_found' | 'noop' }
```

- `requireAdmin()` gate
- Validate `confirm === "REFUND"` (mirrors the DSR-delete pattern)
- Call `refundPerformanceFee(id)`
- `logEvent({ name: 'admin_action', properties: { action: 'perf_fee_refunded', recoveryId, method, adminId, customerId } })`
- Return method + new status

### New query

**`lib/admin/billing-queries.ts`** — add `chargedPerfFees(limit = 200)`:

```ts
SELECT recoveries.id, customer_id, recovered_at, perf_fee_charged_at,
       perf_fee_refunded_at, perf_fee_stripe_item_id, perf_fee_amount_cents,
       plan_mrr_cents, customers.product_name, users.email
FROM   wb_recoveries
JOIN   wb_customers ON ...
JOIN   wb_users     ON ...
WHERE  perf_fee_charged_at IS NOT NULL
  AND  recovery_type = 'win_back'
ORDER BY perf_fee_charged_at DESC
LIMIT 200;
```

No date cut-off — admin can refund any individual charge, including
old ones (per support policy). The 200-row LIMIT prevents accidental
unbounded queries; if/when we have more than 200 charged fees in
flight, add a search box (separate spec).

Returns rows with derived fields `withinRefundWindow` (charged within
14 days) and `stripeMode` ('test' | 'live', based on `STRIPE_SECRET_KEY`
prefix — computed server-side, sent in the API payload).

### Modified API

**`app/api/admin/billing/route.ts`** — extend payload:

```ts
{
  outstanding: [...],         // unchanged
  mrrTrend:    [...],         // unchanged
  recentCharged: [...],       // NEW
  stripeMode: 'test' | 'live' // NEW — used to build dashboard URLs
}
```

### Modified UI

**`app/admin/billing/billing-client.tsx`** — add new section between
"Outstanding" and "MRR trend":

- Table columns: Customer, Charged at, MRR, Fee, Status, Actions
- Status: `Charged` (green) | `Refunded` (slate) | `Item missing`
  (amber, for `line_not_found` historical rows)
- Within-window indicator: subtle " · within 14d" tag for rows where
  `charged_at >= NOW() - 14d AND refunded_at IS NULL`
- Actions:
  - **"View in Stripe"** — opens `https://dashboard.stripe.com{/test}/invoice-items/<itemId>`
    in a new tab. Shown on every row where `perfFeeStripeItemId` is
    not null.
  - **"Refund"** — only on rows where `perf_fee_refunded_at IS NULL`
    AND `perfFeeStripeItemId IS NOT NULL`. Outside the 14-day window,
    button stays enabled but the confirm modal includes a stronger
    warning ("This recovery is X days old — outside the 14-day refund
    policy. Confirm only if support has manually approved this
    refund.").

### Refund-confirm modal

```
Refund $X.XX win-back fee to Customer?
[ ] This subscriber re-cancelled within 14 days OR support has approved an out-of-window refund.
Type REFUND to confirm: [_______]
[Cancel] [Refund]
```

The single checkbox + typed-string mirrors the DSR-delete pattern
(typed confirmation is the only mechanism strong enough — modal
dismissal alone is too easy).

## Edge cases

- **Concurrent refund clicks** — `refundPerformanceFee` is idempotent
  on `perfFeeRefundedAt`. The endpoint returns `method: 'noop'` and
  the UI just refreshes the row state.
- **Stripe API failure mid-refund** — credit-note creation is a
  single Stripe call. On failure, the DB is NOT updated (we set
  `perfFeeRefundedAt` only after the Stripe call returns). Support
  sees the error toast, can retry. The `line_not_found` path
  intentionally marks refunded + emits `win_back_refund_line_missing`
  for separate reconciliation — that's existing behaviour, unchanged.
- **No `perfFeeStripeItemId`** — happens for ancient rows that
  predate item-tracking. Hide the Stripe link, hide the Refund button,
  show "Item missing" status. Support resolves via Stripe Dashboard
  directly.
- **Outside-14-day refund** — button enabled, modal warns. Audit-logged
  with `outside_window: true` property so we can review later.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — add tests:
  1. `recentChargedPerfFees` returns rows in DESC order, applies
     30-day filter
  2. Refund endpoint rejects without `confirm: "REFUND"`
  3. Refund endpoint rejects non-admin
  4. Refund endpoint writes `admin_action` event with
     `perf_fee_refunded`
- [ ] Manual smoke on dev:
  - Use existing `scripts/billing-test-tier3-2-refund-within-window.ts`
    to create a charged perf fee
  - Open `/admin/billing` → confirm row visible in new section
  - Click "View in Stripe" → opens correct test-mode invoice item
  - Click Refund → modal → type "REFUND" → confirm
  - Verify: status flips to Refunded, Stripe credit note exists,
    `admin_action` event in `/admin/audit-log`
- [ ] No prod migration.

## Rollback

- Endpoint is additive; removing it has zero data impact (refunds
  already issued stay issued in Stripe).
- UI section is additive.
- No schema changes to revert.

## Phasing

Single PR. Estimated <300 LOC change.

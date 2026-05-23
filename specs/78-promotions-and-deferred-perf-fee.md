> **⚠️ Historical reference — pricing model was rewritten on 2026-05-23.**
> The "$99/mo + 1× MRR per recovery" and "14-day refund window" mechanics
> described in this doc no longer exist. Current model: tiered flat
> monthly fee priced by the customer's own MRR (Starter $99 / Growth
> $299 / Scale $699 / Enterprise sales-handled), no per-recovery
> charges, no refund windows. See `CLAUDE.md` and
> `/Users/tejay/.claude/plans/we-are-going-to-memoized-kernighan.md`
> for the current model. This doc is preserved as historical record.

# Spec 78 — Stripe-native promotions + deferred performance-fee model

## Context

Today Winback's recovery engine has two reasons to send a cancelled
subscriber a win-back email:

1. **Stated reason** (Tier 1, free-text + classifier) — generic
   personalised email with an open-ended ask or pointer.
2. **Improvement match** (`wb_improvements` + LLM semantic match in
   `src/winback/lib/improvement-match.ts`) — when the merchant ships a
   product change matching the subscriber's stated `triggerNeed`, fire
   a one-shot win-back referencing the fix.

Both matcher and classifier prompts contain a **hardcoded ban on
discounts** (`improvement-match.ts:169`, `classifier.ts:80,140`):
"Never a discount. Never a hard sell." This was Spec 65's positioning
bet — Winback recovers by *listening*, not by discounting.

But `cancellationCategory='Price'` is structurally the largest
cancellation bucket in B2B SaaS, and the product currently returns
nothing for those subscribers beyond an open-ended question. Merchants
already author Stripe promotions; we don't use them.

This spec adds **Stripe-native promotions** (Coupons + Promotion Codes
on the merchant's Connect account) as a new trigger source for
win-back emails, scoped narrowly to **Tier 1 + Price category**, gated
behind a per-merchant opt-in flag. The discount ban remains the
default everywhere else.

A second, load-bearing change rides along: the performance-fee
firing model shifts from **"1× `planMrrCents` at recovery
activation"** to **"1× first-paid-invoice `amount_paid`, fired when
that invoice settles on the merchant's Stripe account"**. This
correctly handles `first-month-free` and `N-months-free` promos,
Stripe trials, and plan changes — all of which the current model
gets wrong by accident or design. No time cap: if the recovered
subscriber eventually pays, we eventually charge; if they never pay,
neither do we. Merchant churn off Winback before the fee fires =
natural forfeit (Stripe rejects invoice items on cancelled
subscriptions). One-sentence merchant pitch: *"1× whatever your
customer's first paid invoice is, charged when that invoice gets
paid; if they never pay, neither do you."*

## Billing model — exact diff vs. today

| Aspect | Today | After |
|---|---|---|
| $99/mo platform sub start trigger | First delivered payment-recovery OR win-back, whichever comes first. | **Unchanged.** |
| Per-win-back perf-fee firing trigger | `recovery.activatedAt` (subscription create) in `activation.ts:154` via `chargePendingPerformanceFees`. | **First Connect-side `invoice.payment_succeeded` with `amount_paid > 0` on the recovered subscription's invoice.** |
| Perf-fee amount basis | `recovery.planMrrCents`. | **`invoice.amount_paid` from the first paid invoice.** Stored in existing `recovery.perfFeeAmountCents`. |
| `recovery.perfFeeChargedAt` semantics | "Activation timestamp" (subscription create time). | **"First-paid-invoice settle timestamp."** Same column, same downstream consumers (refund window, billing display), just deferred. |
| 14-day refund window | `now - 14d > perfFeeChargedAt` keyed off activation-time. | **Same query, same window — just keyed off the new `perfFeeChargedAt` value (first-paid-invoice time).** |
| Refund amount | `recovery.planMrrCents` (`performance-fee.ts:381`). | **`recovery.perfFeeAmountCents`** (what we actually charged, after any discount). |
| Pilot / flat-rate bypass | Skip perf fee (`isCustomerOnPilot`, `getCustomMonthlyCents`). | **Unchanged.** Same gates, applied at fire time. |
| Anything else | — | **No.** 500-recovery cap, free-until-first-delivery semantics, $99 platform fee — all untouched. |

## Promotion ownership — Stripe is the source of truth

**Merchants create promotions in the Stripe Dashboard. Winback never
writes.** No `coupons.create`, no `promotionCodes.create`, no Winback
UI to author a discount. We ingest active promotion codes via
Connect-side webhooks (`promotion_code.created`,
`promotion_code.updated`, `coupon.updated`, `coupon.deleted`) and
render them read-only on `/reasons`. Editing means clicking through
to Stripe Dashboard.

Why:
- Stripe is the billing source of truth — dual-state-of-the-world
  bugs between Winback's promo list and Stripe's would be brutal.
- Merchants get the full power of Stripe's promotion engine for free.
- Roughly halves the implementation surface of this spec.

## UI surface — three minimal touch-points

1. **`/reasons` — new "Promotions" section** below Improvements.
   Read-only table sourced from `wb_improvements WHERE kind='promotion'`.
   Columns: code, terms (`25% off · 3 mo`), target (plan name or "All
   plans"), status (active/inactive), Stripe deep-link. Single
   "Refresh from Stripe" button calls `POST /api/promotions/refresh`.
2. **`/settings` Billing section — one toggle**: "Allow promotional
   offers on price-driven win-backs", flips
   `wb_customers.promotionsEnabled`. Default OFF. Perf-fee explainer
   copy rewritten to "1× first paid invoice" basis.
3. **`/dashboard` subscribers table — inline chip** in the existing
   Reason cell when `recovery.appliedPromotionCodeId IS NOT NULL`.
   Visual: `WINBACK25 · -25% × 3mo` chip in `bg-blue-50/blue-700`
   palette, rendered on its own line below the reason text.

No new pages, no new tabs, no new component primitives.

## AI vs. deterministic split

The LLM is involved in **two** decisions:

1. **Classifier** (`classifier.ts`, unchanged) — produces
   `cancellationCategory='Price'` and `tier`. This is the only gate
   the LLM controls.
2. **Email body generator** (new prompt variant in
   `improvement-match.ts`) — given the *already-chosen* promo,
   writes the plain-text win-back email naming the discount + code +
   duration.

The LLM does **not** pick which promotion to use. Selection is pure
deterministic code:

```
ELIGIBILITY GATE (all must be true)
  customer.promotionsEnabled = true
  recovery.cancellationCategory = 'Price'
  recovery.tier = 1
  promo.active = true
  promo.redeemBy is null OR > now
  promo.timesRedeemed < (promo.maxRedemptions ?? Infinity)
  promo.appliesToPriceIds is empty (= all)  OR  contains subscriber.priceId

TIEBREAK when multiple pass
  1. max(percentOff/100 × subscriber.mrrCents, amountOffCents)
  2. soonest redeemBy
  3. newest createdAt
```

## Goals

1. Ingest active Stripe Promotion Codes from each connected merchant
   account; store as a new kind of `wb_improvements` row.
2. When a subscriber cancels Tier 1 + Price category AND the merchant
   has at least one eligible active promotion for the subscriber's
   plan, generate a promo-aware win-back email instead of the current
   open-ended ask.
3. Activation link applies the promotion to the reactivated
   subscription via Stripe `subscription.discounts: [{ promotion_code }]`.
4. Performance fee = 1× first-paid-invoice `amount_paid`, fired on
   Connect-side `invoice.payment_succeeded`. No time cap. Applies to
   **all** recoveries, not just promo recoveries — strictly better
   than today's "1× planMrrCents at activation" basis in every edge
   case (free trials, free-month promos, plan upgrades, downgrades);
   identical in the common case.
5. Per-merchant opt-in flag (`wb_customers.promotionsEnabled`,
   default `false`).
6. UI: list synced promotions on `/reasons`; opt-in toggle +
   perf-fee explainer on `/settings`; inline promo chip on
   `/dashboard` subscribers table.

## Non-goals

- Tier 2 (Stripe enum only) promotions — too speculative.
- Coupons without a Promotion Code — email needs a redeemable
  customer-facing string; raw `coupon.id` is not customer-facing.
- Discount generation by Winback — merchants create promotions in
  Stripe; we never call `coupons.create` or `promotionCodes.create`.
  No Winback UI to author, edit, or delete a promotion.
- Multi-currency edge cases for `amount_off` coupons in v1 (skip if
  currency doesn't match subscription currency).
- "Match promo type to objection type" (e.g., different copy for
  "too expensive" vs. "budget cut") — credible v2 needing new promo
  metadata; out of scope.
- Backfilling perf-fee model retroactively for already-charged
  recoveries.

## Schema

**Migration 045** — `src/winback/migrations/045_promotions_and_deferred_perf_fee.sql`:

```sql
-- 1. Extend wb_improvements to support promotion-kind rows
ALTER TABLE wb_improvements
  ADD COLUMN kind text NOT NULL DEFAULT 'product'
    CHECK (kind IN ('product', 'promotion'));

ALTER TABLE wb_improvements
  ADD COLUMN promotion_metadata jsonb;

COMMENT ON COLUMN wb_improvements.kind IS
  'Spec 78 — discriminates a merchant-authored product improvement (default) from a Stripe-synced promotion code.';
COMMENT ON COLUMN wb_improvements.promotion_metadata IS
  'Spec 78 — Stripe coupon + promotion-code shape (see types.ts WbPromotionMetadata). NULL for kind=product rows.';

-- 2. Per-merchant promotions opt-in flag
ALTER TABLE wb_customers
  ADD COLUMN promotions_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN wb_customers.promotions_enabled IS
  'Spec 78 — gates the promo-aware win-back path. Default false preserves the "we don\'t recover by discounting" positioning.';

-- 3. Per-recovery applied promotion + perf-fee basis invoice
ALTER TABLE wb_recoveries
  ADD COLUMN applied_promotion_code_id text;
ALTER TABLE wb_recoveries
  ADD COLUMN perf_fee_basis_invoice_id text;

COMMENT ON COLUMN wb_recoveries.applied_promotion_code_id IS
  'Spec 78 — Stripe promotion_code id attached to the reactivated subscription, when the recovery was promo-driven.';
COMMENT ON COLUMN wb_recoveries.perf_fee_basis_invoice_id IS
  'Spec 78 — the Connect-side Stripe invoice id whose amount_paid set the perf-fee basis. Also serves as idempotency key for the invoice.payment_succeeded webhook.';

-- 4. Index for the per-account, per-subscription lookup the new
--    invoice-paid handler does to map invoice → recovery.
CREATE INDEX IF NOT EXISTS idx_wb_recoveries_new_stripe_sub_id
  ON wb_recoveries (new_stripe_sub_id);
```

**`perfFeeAmountCents` already exists** (`schema.ts:371`). The plan's
`perfFeeChargedCents` is the same column — reused.

`promotion_metadata` shape (Zod-validated on read in
`src/winback/lib/promotions.ts`):

```ts
{
  stripeCouponId:        string
  stripePromotionCodeId: string
  code:                  string           // redeemable customer-facing string, e.g. "WINBACK25"
  name:                  string | null    // coupon.name (used for display description)
  percentOff:            number | null    // 0–100
  amountOffCents:        number | null
  currency:              string | null    // ISO 4217 lowercase
  duration:              'once' | 'repeating' | 'forever'
  durationInMonths:      number | null
  redeemBy:              string | null    // ISO datetime
  appliesToPriceIds:     string[]         // empty = applies to all
  maxRedemptions:        number | null
  timesRedeemed:         number
  active:                boolean
  syncedAt:              string           // ISO datetime; when we last pulled from Stripe
}
```

## Code paths touched

| File | Change |
|------|--------|
| `src/winback/migrations/045_promotions_and_deferred_perf_fee.sql` | New migration (above). |
| `lib/schema.ts` | Add `improvements.kind` (text), `improvements.promotionMetadata` (jsonb), `customers.promotionsEnabled` (boolean), `recoveries.appliedPromotionCodeId` (text), `recoveries.perfFeeBasisInvoiceId` (text). |
| `src/winback/lib/promotions.ts` *(new)* | `WbPromotionMetadata` Zod schema; `upsertPromotionImprovement(customerId, stripePromo)`; `archivePromotionImprovement(customerId, stripePromoId)`; `syncActivePromotionsFromStripe(customerId)` (used by the Refresh button and as a self-heal). |
| `src/winback/lib/promotion-match.ts` *(new)* | `findBestPromotionForSubscriber(subscriber, promotionRows): PromotionRow \| null` — pure deterministic eligibility + tiebreak (no LLM). |
| `src/winback/lib/improvement-match.ts` | Add `generatePromotionEmail(...)` and `sanityCheckPromotionEmail(...)` — new prompt variants that lift the discount ban and produce a plain-text email naming the discount + code + duration. Existing `generateImprovementEmail` untouched. |
| `src/winback/lib/reengagement-cron-v2.ts` (or wherever subscribers enter the matcher today) | After existing improvement-match runs and returns no hit: if subscriber is Tier 1 + Price + opt-in flag on, call `findBestPromotionForSubscriber`. If hit, generate the promo email via the new prompt variant, write `recovery.appliedPromotionCodeId`, send. |
| `app/api/stripe/webhook/route.ts` | Add Connect-side handlers: `promotion_code.created`, `promotion_code.updated`, `coupon.updated`, `coupon.deleted` → call `upsertPromotionImprovement` / `archivePromotionImprovement`. Add new branch in `invoice.payment_succeeded` handler: when invoice's subscription matches a `recoveryType='win_back'` row with `perfFeeChargedAt IS NULL`, fire perf fee at `amount_paid` (no-op if `amount_paid = 0`). New helper: `maybeFireWinBackPerfFee(event)`. |
| `src/winback/lib/performance-fee.ts` | Add `chargeWinBackPerfFeeFromInvoice(recoveryId, basisInvoiceId, amountCents)` — variant that sets `perfFeeBasisInvoiceId` for idempotency and uses the passed amount, not `planMrrCents`. Existing `chargePerformanceFee` kept for diagnostic/admin paths but no longer called from activation. `refundPerformanceFee` refunds `perfFeeAmountCents` (line 381) instead of `planMrrCents`. |
| `src/winback/lib/activation.ts` | Remove the `chargePendingPerformanceFees(wbCustomerId)` call (line 154). Update the comment block above it explaining the new deferred firing. Keep platform subscription creation. |
| `app/api/activate/route.ts` or wherever reactivation creates the new Stripe subscription | If `recovery.appliedPromotionCodeId` is set, pass `discounts: [{ promotion_code: <id> }]` to `subscriptions.create`. |
| `app/api/promotions/refresh/route.ts` *(new)* | POST endpoint behind `auth()`. Calls `syncActivePromotionsFromStripe(customer.id)`. Used by the Refresh button on `/reasons`. |
| `app/settings/page.tsx` | Billing section: add the toggle. Update perf-fee explainer copy. |
| `app/settings/settings-client.tsx` (or wherever toggles are interactive) | Wire the toggle to `PATCH /api/customer/promotions-enabled`. |
| `app/api/customer/promotions-enabled/route.ts` *(new)* | PATCH endpoint flipping `customers.promotionsEnabled`. |
| `app/reasons/page.tsx` + `app/reasons/reasons-client.tsx` | Add a "Promotions" section below the existing Improvements list. Reads `wb_improvements WHERE kind='promotion'`. Includes Refresh button + Stripe deep-links. |
| `app/dashboard/dashboard-client.tsx` | Subscribers table win-back row: render promo chip below Reason text when `recovery.appliedPromotionCodeId IS NOT NULL`. Data shape extended via `useWinbackData` hook or `/api/subscribers` query. |
| `src/winback/__tests__/promotion-match.test.ts` *(new)* | Deterministic-matcher fixtures: Tier-1 Price + eligible promo → match; expired promo → no match; opt-in flag off → no match; Feature-category → no match; multiple eligible → tiebreak verified. |
| `src/winback/__tests__/promotion-email.test.ts` *(new)* | Locks the new prompt variant: 250-char cap, banned-phrase check still applies, includes `{code}` placeholder, no discount-ban phrase. |
| `src/winback/__tests__/performance-fee.test.ts` | Add cases for: (a) deferred fire on invoice-paid; (b) idempotency via `perfFeeBasisInvoiceId`; (c) refund uses `perfFeeAmountCents` not `planMrrCents`; (d) `amount_paid = 0` invoices skipped. |

## Edge cases handled

1. **Promotion expires between email send and click** — activation
   flow re-checks `redeemBy` + `active` before attaching. If expired,
   activate without discount and emit `promo_expired_at_activation`.
2. **Promotion fully redeemed between match and click** — same:
   activate without discount, emit event.
3. **Subscriber on a price the coupon doesn't apply to** — matcher
   eligibility gate excludes.
4. **Currency mismatch** (amount_off coupons against differently-
   denominated sub) — skip in v1 with `promo_currency_mismatch` event.
5. **Multiple eligible promotions** — tiebreak as specified above.
6. **Merchant deletes promo in Stripe mid-flight** — `coupon.deleted`
   webhook archives the row; in-flight recovery activates without
   discount + emits event.
7. **Re-cancel within 14 days** — `perfFeeChargedAt` now reflects
   first-paid-invoice settle time, so the 14-day clock runs from
   then. Refund amount: `perfFeeAmountCents`.
8. **Pilot / flat-rate bypass** — same gates in
   `chargeWinBackPerfFeeFromInvoice` as in `chargePerformanceFee`.
9. **Opt-in flag off when promo exists** — promo ingested, never
   matched.
10. **`first month free` (100% off, once)** — first invoice
    `amount_paid = 0`, handler skips. Second invoice = full MRR,
    handler fires. 14-day refund window starts at second invoice.
11. **`first 90 days free` / `first year free`** — first non-zero
    invoice settles whenever; perf fee fires then. Time-shifted but
    symmetric.
12. **Plan upgrade on reactivation** ($50 → $200) — first paid
    invoice = $200, perf fee = $200.
13. **Plan downgrade on reactivation** ($200 → $50) — perf fee = $50.
14. **Multiple paid invoices** — `perfFeeBasisInvoiceId` set on
    first fire; later webhook invocations short-circuit before
    creating a second invoice item.
15. **Subscriber cancels before any non-zero invoice** — nothing
    happens. `perfFeeChargedAt` stays null, we never charge.
    `processChurn` requires no change; the natural state IS the
    terminal state.
16. **Merchant churns off Winback before any pending fee fires** —
    Winback subscription cancels; Stripe rejects new invoice items
    on a cancelled subscription. Pending fees naturally forfeit. No
    code change required.
17. **Webhook for invoice.payment_succeeded fires twice for the same
    invoice** (Stripe retries) — `perfFeeBasisInvoiceId` set
    atomically on first fire; second-fire check short-circuits.
18. **Activation runs before card on file** (today's "awaiting_card"
    state) — fine. Platform sub creation still gated on card. When
    card arrives + sub exists + recovered subscriber pays, the
    new invoice handler fires.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — all tests green, including new
      `promotion-match.test.ts`, `promotion-email.test.ts`, and
      updated `performance-fee.test.ts`
- [ ] Migration 045 applied to Neon dev. Existing rows:
      `wb_improvements.kind = 'product'`, `wb_customers.promotions_enabled = false`.
- [ ] **End-to-end on local dev** (founder account
      `tejaasvi@gmail.com` + Stripe test platform `tkedambadi@gmail.com`):
  1. Create a Stripe Promotion Code on the merchant's Connect account
     (e.g., `TESTPROMO50`, 50% off, duration: once, no expiry).
  2. Verify webhook ingests into `wb_improvements` with
     `kind='promotion'` + populated `promotion_metadata`.
  3. Enable the promotions toggle in `/settings`.
  4. Cancel a test subscriber citing "too expensive". Verify
     classifier returns Tier 1 + Price.
  5. Trigger reengagement cron. Verify a promo-aware email is queued
     (subject + body contains the discount + code).
  6. Click the activation link; verify the new Stripe subscription
     has `subscription.discounts[0].promotion_code` set + `wb_recoveries.applied_promotion_code_id` populated.
  7. Verify `wb_recoveries.perf_fee_charged_at IS NULL` immediately
     after activation — perf fee not fired yet.
  8. Advance Stripe test clock or wait for the first invoice to
     settle. Verify perf fee fires with `amount_cents =
     invoice.amount_paid`, `perf_fee_charged_at` set,
     `perf_fee_basis_invoice_id` set, invoice item created on the
     merchant's Winback platform subscription.
  9. Re-cancel within 14 days; verify credit-note refund for
     `perfFeeAmountCents` (not `planMrrCents`).
  10. Separate run: `first month free` promo (100% off, duration once).
      Verify perf fee = $0 on the $0 invoice (handler skipped on
      `amount_paid = 0`), then fires for full MRR when the second
      invoice settles ~30 days later.
  11. Separate run: reactivate, then cancel on day 5 (before any
      non-zero invoice). Verify `perf_fee_charged_at` stays null and
      no Stripe invoice item was created on the merchant's Winback
      subscription.
- [ ] Opt-in flag respected: with `promotions_enabled = false`, promo
      is ingested but no match fires for a Price-Tier-1 cancel.
- [ ] Banned-phrase / 250-char validation still enforced on
      promo emails. Manual prompt review against
      `GENERATE_PROMOTION_SYSTEM_PROMPT` lock.
- [ ] `?dryRun=1` query-param on the reengagement cron prints
      would-match promotions without sending.

## Rollout

Single feature branch `claude/add-promotions-winback-72Xx3` with
commits structured in the order below so each layer is testable
independently:

1. **Commit 1 — spec doc.** This file.
2. **Commit 2 — migration + schema.** Migration 045 +
   `lib/schema.ts` updates. Backfill is the migration's DEFAULTs
   (existing rows get `kind='product'`, `promotions_enabled=false`).
3. **Commit 3 — perf-fee model change.** Remove
   `chargePendingPerformanceFees` from `activation.ts`. Add
   `chargeWinBackPerfFeeFromInvoice` to `performance-fee.ts`. Add
   `maybeFireWinBackPerfFee` to the webhook handler. Update
   `refundPerformanceFee` to use `perfFeeAmountCents`. Update tests.
4. **Commit 4 — promotions ingestion.** Connect-side webhook
   handlers for promotion_code + coupon events.
   `src/winback/lib/promotions.ts` upsert/archive/sync.
5. **Commit 5 — promotions matcher + email + activation discount.**
   `promotion-match.ts` deterministic matcher.
   `generatePromotionEmail` + sanity check. Reengagement-cron-v2
   wire-up. Activation flow passes `discounts: [{ promotion_code }]`.
6. **Commit 6 — UI.** Settings toggle (+ API endpoint). Reasons
   Promotions section (+ Refresh API). Dashboard promo chip.
7. **Commit 7 — tests.** `promotion-match.test.ts` +
   `promotion-email.test.ts` + `performance-fee.test.ts` additions.
8. **Push** the branch.

## Locked decisions

- **Scope of discount-ban lift:** only the new
  `GENERATE_PROMOTION_SYSTEM_PROMPT` variant. The existing
  `GENERATE_SYSTEM_PROMPT` (improvement-match) and classifier prompts
  keep the ban.
- **Perf-fee column reuse:** `perfFeeAmountCents` (already in
  schema) is the "what we charged" column. No new `perfFeeChargedCents`.
- **`customers.promotionsEnabled` default:** `false`. Merchants
  opt in explicitly.
- **Selection logic:** deterministic, not LLM. Stripe primitives
  (`appliesToPriceIds`, `redeemBy`, `maxRedemptions`) carry merchant
  intent.
- **Connect-side `invoice.payment_succeeded` is the only firing
  trigger.** No backup cron, no time cap, no
  cancel-while-pending handler. Forfeit naturally on merchant churn.

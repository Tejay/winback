# Spec 79 — Promo codes: foundation (auto-sync + visibility + E2E coverage)

> **Builds on Spec 78** (`78-promotions-and-deferred-perf-fee.md`). Spec 78
> introduced the promo-code subsystem (schema, merchant UI, 4-gate
> verification, Stripe-checkout attachment). It was implemented but
> never tested end-to-end, and the billing rewrite (Spec 77 + migration
> 051) removed pieces of it because they were entangled with the
> performance-fee model. This spec makes the remaining promo path
> trustworthy as a v1 product.

## Context

The promo-code feature, as it stands today, has four concrete gaps that
prevent it from being shippable to real merchants:

1. **No automatic Stripe sync.** Webhook handlers
   (`processPromotionCodeUpsert`, `processCouponUpdated`,
   `processCouponDeleted`) were removed in the billing rewrite because
   they fed the now-deleted perf-fee ingest path. Today merchants must
   click "Refresh from Stripe" on `/reasons` every time they create or
   modify a code. They will forget; codes will get stale; the matcher
   will silently fail to fire or, worse, fire with stale metadata that
   Stripe rejects at checkout.

2. **No visibility into which recoveries used a promo.** The
   `appliedPromotionChip` field on `/api/subscribers` is hardcoded to
   `null` (`app/api/subscribers/route.ts:182-189`). The dashboard chip
   markup exists (`app/dashboard/dashboard-client.tsx:1054-1061`) but
   has no data to display. The `applied_promotion_code_id` column on
   `wb_recoveries` was dropped in migration 051, so there is currently
   no join path from a recovery back to the promo that drove it.
   Merchants cannot tell whether the feature is working or which codes
   are paying for themselves.

3. **Hardcoded conditions, invisible to merchants.** The matcher only
   fires when `subscriber.tier === 1` **and**
   `subscriber.cancellationCategory === 'Price'`
   (`src/winback/lib/promotion-match.ts:76-79`). These are reasonable
   defaults but no UI surface tells merchants this; they enable promos
   expecting broad coverage and get a much narrower fire-rate.

4. **Zero end-to-end test coverage.** No automated test verifies the
   full chain (configure → match → email URL contains code →
   reactivate endpoint → Stripe Checkout applies discount → recovery
   row records improvement). The 4 verification gates also have no
   unit-test coverage.

This spec closes those four gaps without expanding scope. Per-theme
promo assignment, A/B testing, configurable tier scope, anti-fatigue
cooldown — all explicitly deferred (see Non-goals).

## Goals

1. **Stripe is the source of truth.** A merchant creates / edits /
   deletes a promotion code in Stripe; WinbackFlow's stored metadata
   reflects that within ~30 seconds of the event, with no merchant
   action required.
2. **Every recovery driven by a promo is attributable.** The dashboard
   recovery row shows which code was applied. A simple per-code metric
   on `/reasons` shows recoveries/MRR driven over the last 30 days.
3. **The fire-conditions are visible.** The merchant reading `/reasons`
   understands exactly what they're enabling — namely, that the offer
   goes only to top-tier, price-cancelled subscribers, and that Stripe
   does the final eligibility check at checkout.
4. **The full flow is covered by tests.** Both unit tests of the 4
   gates and an end-to-end test against Stripe test mode exist and
   pass.

## Non-goals (explicitly out of scope)

| Deferred feature | Why |
|---|---|
| Per-theme promo assignment (different codes per cancellation reason) | Single global promo first; validate visibility before adding configurability |
| Configurable tier scope | Defaults are sound; merchants can ask if they want broader fire |
| Configurable cancellation-category filter | Same |
| A/B test mode (50% get promo, measure lift) | Build measurement first; A/B test once we know baseline works |
| Anti-fatigue cooldown (no re-offer to same subscriber within N days) | Real future need; not blocking v1 utility |
| Standalone `/promotions` analytics page | Inline metric on `/reasons` is the minimum-viable surface |
| Lift-vs-baseline statistical analysis | Premature without per-recovery attribution working first |
| Manual per-subscriber promo send from dashboard drawer | Genuinely useful (VIP / AI-miss escape hatch) but needs gate-check infrastructure + `applied_improvement_id` column from this spec to land first. Becomes **Spec 80** as a follow-up. |

Each of these is a real future improvement; none are needed to make
this slice trustworthy.

## Conditions — when does a promo fire?

A promo is attached to a winback email if **all** of these hold. (No
change from today's matcher logic except the rule disclosure in the
UI.)

| Condition | Source | Configurable in v1? |
|---|---|---|
| `wb_customers.promotions_enabled = true` | DB | Yes — existing toggle on /reasons |
| `wb_customers.selected_promotion_improvement_id IS NOT NULL` | DB | Yes — existing radio on /reasons |
| Promo is active in Stripe (`promotionMetadata.active = true`) | gate 1 in `promotion-match.ts` | No — Stripe truth |
| `promotionMetadata.redeemBy` not yet passed | gate 2 | No — Stripe truth |
| `promotionMetadata.timesRedeemed < promotionMetadata.maxRedemptions` | gate 3 | No — Stripe truth |
| `promotionMetadata.appliesToPriceIds` includes subscriber's plan price | gate 4 | No — Stripe truth |
| `subscriber.tier === 1` | classifier | No (hardcoded; documented in UI) |
| `subscriber.cancellationCategory === 'Price'` | classifier | No (hardcoded; documented in UI) |

If any condition fails, the email goes out **without** the promo
rather than failing entirely. Current behavior, kept.

## Mechanism — end-to-end flow

1. **Setup.** Merchant creates a promotion code in Stripe.
2. **Sync (auto).** Stripe webhook (`promotion_code.created` /
   `promotion_code.updated` / `coupon.updated` / `coupon.deleted`) →
   WinbackFlow handler upserts the code into `wb_improvements` using
   the existing `upsertPromotionImprovement()`.
3. **Sync (fallback).** "Refresh from Stripe" button on `/reasons`
   remains as a manual fallback for the rare case of a missed webhook.
4. **Selection.** Merchant on `/reasons` enables promotions and picks
   one code (existing UI, no change beyond adding the rule disclosure).
5. **Application.** Re-engagement cron runs
   (`reengagement-cron-v2.ts → tryPromotionPath`). The 8 conditions
   above are checked. If all pass, the code is attached to the email
   URL.
6. **Reactivation.** Subscriber clicks the email link → reactivation
   endpoint re-validates the 4 Stripe gates (defense-in-depth in case
   anything changed between send and click) → Stripe Checkout opens
   with the code in `discounts: [...]`.
7. **Enforcement.** Stripe applies the discount or rejects (e.g.
   first-time-only restriction the merchant set). WinbackFlow never
   overrides.
8. **Tracking.** On successful checkout, the recovery row records
   `applied_improvement_id` (new column). Dashboard chip renders.

## Schema

### Migration 053 — `applied_improvement_id` on recoveries

```sql
-- src/winback/migrations/053_recovery_promo_attribution.sql
--
-- Restores a join path from a recovery back to the promotion that
-- drove it. The old applied_promotion_code_id column on wb_recoveries
-- was dropped in migration 051 because it was entangled with the
-- now-deleted perf-fee path. This column is FK-clean (references
-- wb_improvements directly) and serves the dashboard chip + per-code
-- attribution metric described in spec 79.

ALTER TABLE wb_recoveries
  ADD COLUMN IF NOT EXISTS applied_improvement_id UUID
    REFERENCES wb_improvements(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_recoveries_applied_improvement_id
  ON wb_recoveries(applied_improvement_id)
  WHERE applied_improvement_id IS NOT NULL;
```

Index is partial (only non-null rows) — most recoveries will not have
a promo attached, and only the chip-lookup and the per-code metric
query need the index.

### `lib/schema.ts`

Mirror the column on the Drizzle `recoveries` table:

```ts
appliedImprovementId: uuid('applied_improvement_id')
  .references(() => improvements.id, { onDelete: 'set null' }),
```

## Code paths touched

### Restore (was removed in billing rewrite — re-scope to wb_improvements, not perf-fee)

**`app/api/stripe/webhook/route.ts`** — re-add handlers for:

- `promotion_code.created`, `promotion_code.updated`:
  - Call `buildPromotionMetadata(coupon, promotionCode)` from `src/winback/lib/promotions.ts` to build the WbPromotionMetadata shape.
  - Call `upsertPromotionImprovement(customerId, metadata)` to write/update the `wb_improvements` row.
- `coupon.updated`:
  - Look up any `wb_improvements` rows referencing this coupon ID; re-build their metadata and upsert.
- `coupon.deleted`:
  - Look up any `wb_improvements` rows referencing this coupon ID; mark them archived (existing archive mechanism).

The previous removal comment at `route.ts:1094-1098` should be replaced with a comment explaining the re-scoped purpose ("sync to wb_improvements only; perf-fee path is gone").

### Add

**`src/winback/migrations/053_recovery_promo_attribution.sql`** — as above.

**`lib/schema.ts`** — mirror new column.

**`src/winback/lib/reengagement-cron-v2.ts`** — in `tryPromotionPath`,
after a recovery row is written via the existing recovery insert path,
also set `appliedImprovementId` on that row to
`selectedPromotion.improvementId`. (The promo metadata already carries
this id; the wire-up is a single field.)

**`app/api/subscribers/route.ts`** — replace the hardcoded `null` at
lines 182-189 with a real lookup:

```ts
// For each subscriber, find their most recent recovery row that
// recorded an applied_improvement_id, join to wb_improvements, return
// { code, discount } from promotionMetadata. Returns null if none.
```

Shape returned to client (unchanged from what the chip expects):

```ts
appliedPromotionChip: {
  code: string         // e.g. "WELCOME50"
  discount: string     // e.g. "50% off" or "$10 off"
} | null
```

**`app/dashboard/dashboard-client.tsx`** — the chip markup at
lines 1054-1061 already exists. No UI rebuild needed; once the route
above returns real data, the chip lights up automatically.

**`app/reasons/promotions-section.tsx`** — two additions:

1. **Rule disclosure** as a subtitle directly under the promo
   selector. Suggested text:

   > *Offered only to top-tier subscribers whose cancellation reason
   > was price-related. Stripe verifies eligibility at checkout.*

2. **Per-code metric** below each promo option:

   > *Drove **3 recoveries** / **$890 MRR** in the last 30 days.*

   Query: `wb_recoveries` filtered to
   `applied_improvement_id = improvement.id AND recovered_at >= now() - INTERVAL '30 days'`.
   Aggregates: count(*) and sum(plan_mrr_cents).

   Same shape as the existing ROI block — reuse `fmtUsd()`.

### Tests

**`src/winback/__tests__/promotion-match.test.ts`** (new) — unit
coverage for each of the 4 Stripe gates in
`getApplicablePromotionForSubscriber()`. Crafted promo + subscriber
fixtures asserting:

- inactive promo (`active=false`) → null
- past `redeemBy` → null
- `timesRedeemed >= maxRedemptions` → null
- subscriber's `currentPriceId` not in `appliesToPriceIds` → null
- all 4 gates pass + tier=1 + Price category → returns the promo
- all 4 gates pass but tier=2 → null
- all 4 gates pass but cancellationCategory='Feature' → null

**`src/winback/__tests__/promotion-flow.test.ts`** (new) — E2E test
against Stripe test mode. Gated by `STRIPE_TEST_SECRET_KEY` env so it
opt-in in CI (matches the existing pattern for Stripe-touching tests).
Test plan:

1. Create a 50%-off coupon + promotion code in Stripe sandbox via SDK.
2. POST to the webhook handler with a synthetic `promotion_code.created`
   event → assert `wb_improvements` row created with correct metadata.
3. Set up a fixture customer with `promotionsEnabled=true`,
   `selectedPromotionImprovementId` pointing at the new improvement.
4. Set up a fixture tier-1 subscriber with `cancellationCategory='Price'`.
5. Run the matcher → assert email URL contains the promo code.
6. Hit the reactivate endpoint with that subscriber → assert Stripe
   Checkout receives the discount in its `discounts` array.
7. Simulate a successful checkout via webhook → assert recovery row
   has `appliedImprovementId` set.

### Modify (stale test cleanup)

**`src/winback/__tests__/subscribers-pagination.test.ts`** — line 17
references `appliedPromotionCodeId` which was dropped in migration
051. Update to `appliedImprovementId` (the new column) or drop the
reference entirely.

## Edge cases handled

- **Webhook arrives before customer ever opens /reasons.** Sync writes
  `wb_improvements` row anyway. When merchant later visits, the
  refreshed list includes it.
- **Webhook arrives for a coupon not yet associated with any
  improvement.** Handler treats it as no-op (no `wb_improvements` row
  to update); no error.
- **Merchant deletes the promo in Stripe while it's the selected one.**
  `coupon.deleted` webhook archives the improvement. Matcher's
  existing `active=false` check (gate 1) prevents it firing.
  `selected_promotion_improvement_id` on the customer still points
  there; UI shows "Selected promo is no longer active" badge (existing
  pattern from the manual-refresh flow — verify it still triggers).
- **Stripe gate flips between send-time and click-time.** Reactivation
  endpoint already re-validates the 4 gates
  (`loadAppliedPromotionForSubscriber` at
  `src/winback/lib/promotions.ts:453-493`). On any gate failure,
  checkout proceeds without the discount. Subscriber sees the listed
  price; no broken-checkout state.
- **Subscriber redeems → recovery row written → merchant later edits
  promo metadata in Stripe.** Recovery's `applied_improvement_id`
  still points at the (now-edited) improvement row. Chip displays the
  current code/discount, which may differ from what the subscriber
  actually redeemed. **Acceptable tradeoff** — alternative is
  immutable snapshot per recovery, which adds storage cost and is
  overkill for the dashboard chip's purpose (signal that *a* promo was
  used, not the exact terms).
- **Two webhooks arrive concurrently for the same coupon.** Existing
  `upsertPromotionImprovement` is idempotent (upsert pattern); last
  writer wins, which is correct semantically.

## Verification

### Manual E2E (Stripe test mode)

1. Create a 50%-off coupon + promotion code in Stripe sandbox.
2. Verify it auto-appears in `/reasons` within ~30s (no manual refresh).
3. Enable promotions, select the new code.
4. Trigger churn on a tier-1 fixture subscriber with a price-related
   cancellation reason (`npm run cancel:test`).
5. Verify the reengagement email URL includes the code.
6. Click the URL → Stripe Checkout displays the discount.
7. Complete checkout → subscription created with discount applied.
8. Dashboard recovery row shows ✓ Recovered via `{CODE}` chip.
9. `/reasons` shows the per-code metric "1 recovery / $X MRR (30d)"
   for the just-redeemed promo.
10. **Gate sanity checks:**
    - Edit the Stripe promo to `max_redemptions = 1`
      (already-redeemed) → run matcher on another fixture → email goes
      out WITHOUT the promo.
    - Same test with `redeem_by` in the past.
    - Same test with `active = false`.
    - Same test with `applies_to.products` excluding the subscriber's
      plan.
11. Delete the promo in Stripe → confirm the improvement row is
    archived within ~30s and the matcher stops firing.

### Automated

- `vitest run promotion-match.test.ts` — gates exercised in isolation.
- `vitest run promotion-flow.test.ts` — E2E against Stripe test mode
  (env-gated).

### Verification of the "Stripe is master" promise

- Confirm: deleting a promo in Stripe → archived in WinbackFlow within
  ~30s (webhook).
- Confirm: a fully-redeemed promo gates out at send time (gate 3 fires
  before the email is composed, not just at checkout).
- Confirm: a promo with a first-time-transaction restriction lets the
  email go through but Stripe rejects at checkout. Subscriber sees a
  clean "code not valid" message from Stripe (not from us). Verify
  this rejection path doesn't surface as an error in our logs.

## Rollout

- Greenfield-safe: no live paying customers, no promo data to migrate.
- Migration 053 is additive (new column, nullable, no data
  transformation needed); apply via existing
  `scripts/apply-migration.ts` pattern.
- Webhook handlers register additively; no removal of existing
  handlers required.
- All work lands on branch `promo-codes-v1`; merges via PR once
  manual + automated verification passes.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Per-theme promo assignment | **Deferred.** Single global promo for v1. |
| 2 | Configurable tier / category scope | **Deferred.** Hardcoded to tier-1 + Price, surfaced in UI. |
| 3 | A/B test mode | **Deferred.** Measurement first. |
| 4 | Anti-fatigue cooldown | **Deferred.** Real future need; not blocking. |
| 5 | Stripe webhook sync | **Restore.** Re-add the handlers that were removed in migration 051, scoped to wb_improvements only (not perf-fee). |
| 6 | Recovery → promo join | **New column.** `applied_improvement_id` on `wb_recoveries`, FK to `wb_improvements`. Migration 053. |
| 7 | Snapshot promo terms per recovery | **No.** Recovery row points at the (live) improvement. Edits to the promo will be reflected in the dashboard chip. Acceptable tradeoff. |
| 8 | Per-code metric placement | **Inline on /reasons** under each promo option. No separate analytics page. |
| 9 | Rule disclosure | **Yes.** Subtitle under promo selector documents tier-1 + Price scope. |
| 10 | E2E test infrastructure | **Stripe test mode** with `STRIPE_TEST_SECRET_KEY` env gate, matching existing pattern. |
| 11 | Manual per-subscriber promo send | **Deferred to Spec 80.** Spec 79 lays the gate-check + attribution infrastructure that Spec 80 will reuse. Building manual first would duplicate that infrastructure; the order matters. |

## Acceptance criteria

1. A `promotion_code.created` event posted to the webhook endpoint
   results in a `wb_improvements` row visible on `/reasons` within
   one page refresh, with no merchant action required.
2. A `promotion_code.updated` event reflects the new terms in
   `wb_improvements.promotion_metadata` within one webhook delivery.
3. A `coupon.deleted` event archives all `wb_improvements` rows
   referencing that coupon and the matcher stops firing for them.
4. With promotions enabled and a valid promo selected, a tier-1
   subscriber with `cancellationCategory='Price'` receives an email
   whose URL includes the promo code in the `discounts` parameter.
5. The same flow for a tier-2 subscriber, or a tier-1 subscriber with
   `cancellationCategory='Feature'`, produces an email WITHOUT the
   promo.
6. Each of the 4 Stripe gates (active, redeemBy, maxRedemptions,
   appliesToPriceIds) failing independently produces an email
   WITHOUT the promo (verified by unit test + manual).
7. Clicking through the email link opens Stripe Checkout with the
   discount applied. The recovery row that results has
   `applied_improvement_id` set.
8. The dashboard row for that recovery renders ✓ Recovered via
   `{CODE}` (chip).
9. The `/reasons` per-code metric shows the recovery count and MRR
   sum from the last 30 days, filtered by improvement.
10. The rule-disclosure subtitle is visible to merchants on `/reasons`
    when they enable promotions.
11. `vitest run promotion-match.test.ts` passes; covers all 4 gates +
    tier/category filters.
12. `vitest run promotion-flow.test.ts` passes against Stripe test
    mode (when `STRIPE_TEST_SECRET_KEY` is set).

## Open items

None blocking. The plan's "open question for explicit user sign-off"
(per-theme assignment in v1) has been answered: deferred to a future
spec.

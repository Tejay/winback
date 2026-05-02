# Spec 46 — Recovery rate per cancellation reason (AI feedback loop)

**Phase:** Dashboard depth — diagnostic for both merchant and product
**Depends on:** Spec 40 (pattern strip — establishes the
cancellationCategory aggregation we extend), Spec 19b (categories
populated on every classification)
**Estimated time:** ~half a day + tests

---

## Context

The dashboard's "Top reasons" pattern strip today shows **frequency**
of cancellation categories from the last 30 days:

> Top reasons (last 30d): Price (32%) · Features (24%) · Switched (18%) · Other (26%)

What it doesn't show — and what would be far more actionable — is
the **recovery rate per reason**:

> Top reasons (last 30d):
>   Features (24%) · 35% recovered
>   Price (32%) · 8% recovered
>   Switched (18%) · 12% recovered
>   Other (26%) · 18% recovered

Two payoffs:

1. **Merchant gets a roadmap signal.** "We recover 35% of feature-based
   cancels but only 8% of price-based" tells the merchant exactly
   where the AI is winning vs losing — and where their own action
   (build the feature, hold the price) would shift the outcome.

2. **You get an AI feedback loop.** Same data tells you which
   categories your classifier-and-emailer is good at and which
   need iteration. The pattern strip becomes a quality signal for
   the product, not just a frequency display.

Same pattern strip surface, just a richer aggregation behind it.
No new component, no new layout, no new data source — the recovery
counts per category are already in the database.

## Goals

- Extend the `topReasons` aggregation in `/api/stats` to compute
  `recoveredPct` per category alongside the existing frequency
  `pct`.
- Same shape applies to `topDeclineCodes` (payment-recovery cohort)
  — recovery rate per decline reason (`insufficient_funds` vs
  `expired_card` etc.).
- UI: extend `PatternPills` to render the second number under each
  category as a small muted line ("35% recovered").
- Sample-size guard: don't show recovery rate per category when
  the category has fewer than 3 cancellations in the window
  (`pct` of 1 row recovered = "100% recovered" on a 1-row sample
  is the same misleading-percentage problem we already fixed at
  the strip level in Spec 40).

## Non-goals

- **Time-series of recovery rate per reason** ("Price recovery rate
  is trending up over the last 90 days") — separate analytics
  surface.
- **Drill-down** (clicking "Price" filters the table to those
  rows). Future spec.
- **Per-tier breakdowns** ("Price-based cancels at tier-1 vs tier-2
  recover at different rates").
- **Confidence intervals** on the recovery-rate percentages —
  cute statistically but UI clutter; the per-category sample-size
  guard handles the worst misreads.

## What changes

### A. Pure helper extension — `src/winback/lib/stats.ts`

Extend the `topNFromCounts` helper (or add a sibling) that takes
both **total** counts and **recovered** counts per label and emits
both `pct` (frequency) and `recoveredPct`:

```ts
export type LabelPctWithRecovery = {
  label: string
  pct: number              // share of total (existing)
  recoveredPct: number | null  // share of THIS label that recovered
                                // null = below sample-size floor for rate
}

export function topNFromCountsWithRecovery(
  rows: Array<{ label: string | null; count: number; recoveredCount: number }>,
  n: number,
  opts: { minTotal?: number; minPerLabelForRate?: number } = {},
): LabelPctWithRecovery[]
```

`minTotal` (existing): hide whole strip if total < N (e.g. 3) —
already in use.

`minPerLabelForRate` (new): emit `recoveredPct: null` for any
label whose `count < N` (e.g. 3) — frequency still shown ("Price
1%") but no rate next to it (avoid "100% recovered" on a 1-row
sample). Default 3.

### B. `/api/stats` — extend the per-cohort pattern queries

Currently the queries group by category/decline-code and count
rows. Extend each to also count rows where `status = 'recovered'`:

```sql
SELECT
  cancellation_category AS label,
  count(*)::int AS count,
  count(*) FILTER (WHERE status = 'recovered')::int AS recovered_count
FROM wb_churned_subscribers
WHERE customer_id = $1
  AND cancelled_at >= $window
  AND (cancellation_reason != 'Payment failed' OR cancellation_reason IS NULL)
GROUP BY cancellation_category;
```

Same shape for the payment-recovery query (`last_decline_code`,
`created_at >= $window`).

Pipe through the new helper variant. Output type:

```ts
topReasons: LabelPctWithRecovery[]      // was LabelPct[]
topDeclineCodes: LabelPctWithRecovery[]  // was LabelPct[]
```

This is a breaking change to the `Stats` type, so the dashboard
needs to update simultaneously. Both files in the same commit.

### C. Dashboard — `PatternPills` component

Currently renders a row of pills with frequency only. Extend to
render category + frequency on the first line, recovery-rate on a
second small line under each pill (or as a parenthetical inside
the pill — designer's call):

```
┌─────────────────────────────┐  ┌─────────────────────────────┐
│  Features  24%              │  │  Price  32%                  │
│  35% recovered              │  │  8% recovered                │
└─────────────────────────────┘  └─────────────────────────────┘
```

Hide the recovery-rate line when `recoveredPct === null` (sample
too small). Keep the frequency pill rendering unchanged in that
case.

Color hint: optional — tint the recovery-rate text emerald when
above some threshold (e.g. ≥30%) and amber/rose below to give a
visual signal of "where AI is winning." Probably worth doing —
matches the loss-framing color semantics from Spec 43.

## Critical files

| Path | Change |
|---|---|
| `specs/46-recovery-rate-per-reason.md` | **new** (this file) |
| `src/winback/lib/stats.ts` | New `LabelPctWithRecovery` type + `topNFromCountsWithRecovery` helper (or extend the existing `topNFromCounts` signature) |
| `app/api/stats/route.ts` | Extend the two pattern queries with `count(*) FILTER (WHERE status='recovered')` columns; pipe through the new helper; update `Stats` type |
| `app/dashboard/dashboard-client.tsx` | `Stats` interface change; `PatternPills` component renders the second-line recovery-rate (with tint color); `EMPTY_STATS` defaults |
| `src/winback/__tests__/stats-aggregation.test.ts` | New tests for `topNFromCountsWithRecovery`: zero rows, single category 100% recovered, single category 0% recovered, mixed categories with per-label sample-size guard, `recoveredCount > count` clamp behavior (defensive — shouldn't happen but should not crash) |

No schema changes. No migration. No new env vars.

## Edge cases

1. **Category with 1 row, 1 recovered** → would naively read "100%
   recovered" — hidden by `minPerLabelForRate` guard. Frequency
   pill still renders.
2. **Category with 0 recovered** → "0% recovered" rendered — that
   IS the signal the merchant wants (the AI is failing this
   category).
3. **Brand-new tenant with no cancellations** → pattern strip
   already hides at the strip level (Spec 40 minTotal); this spec
   doesn't change that.
4. **`recoveredCount > count`** — theoretically impossible but
   clamp `recoveredPct` to 100 defensively.
5. **Tie-broken category ordering** — existing alphabetical
   tiebreak in `topNFromCounts` stays.
6. **Decline code "other"** (rare codes lumped) — show recovery
   rate for it too; it's still meaningful aggregate.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — new helper tests pass
- [ ] DB cross-check on demo data:
      ```sql
      SELECT cancellation_category,
        count(*) AS total,
        count(*) FILTER (WHERE status='recovered') AS recovered,
        ROUND(100.0 * count(*) FILTER (WHERE status='recovered') / count(*)) AS rate
      FROM wb_churned_subscribers
      WHERE customer_id = $cust AND cancelled_at >= NOW() - INTERVAL '30 days'
      GROUP BY cancellation_category
      ORDER BY total DESC;
      ```
- [ ] Dashboard click-through both tabs:
  - Pattern strip shows recovery rate per category
  - Categories with <3 rows show frequency only, no rate
  - Color tinting (if implemented): high recovery = emerald, low
    = amber/rose
- [ ] Cross-check: numbers in the strip match the DB query

## Out of scope (future)

- Time-series ("Price recovery rate over last 90 days")
- Drill-down (clicking a category filters the table)
- Per-tier breakdown
- Recovery rate per `triggerNeed` (richer than category)
- Alerting when a category's recovery rate drops below historical
  average — useful product signal but separate spec

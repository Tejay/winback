# Spec 41 — Cumulative revenue saved (cached metric)

**Phase:** Dashboard polish / ROI clarity
**Depends on:** Spec 39 (dashboard KPI split — establishes the
"MRR recovered" card as the place this metric lives), Spec 18
(`recoveryType` populated on every recovery)
**Estimated time:** ~half a day + tests

---

## Context

The dashboard's "MRR recovered" KPI today sums `mrrCents` across all
recoveries — the **monthly subscription value at the moment of
recovery**. A recovered customer who stays 18 months delivered 18× that
MRR in actual revenue, but the card still credits Winback for 1×.

The label is also genuinely ambiguous. A merchant reads
"MRR recovered: $480" and could plausibly think:

- "$480 of total dollars" (one-time)
- "$480/mo going forward" (run-rate, the current behavior)
- "$480 per customer per month" (rate, nonsense)

This understates the product's ROI exactly when merchants need that
number to justify the $99/mo + 1× MRR fee. A merchant 12 months in,
with $480/mo of recovered MRR that's all still active, has actually
saved ~$5,760 in revenue Winback can take credit for — but the
dashboard shows $480.

Computing the true number on the dashboard's hot path was rejected
because the dashboard already runs ~10 queries per request and
walking every recovery + retention check on each load doesn't scale.

## Goals

- New cached integer column on `customers`:
  `cumulative_revenue_saved_cents`. Updated daily by a cron;
  read directly from the dashboard with no aggregation.
- Dashboard "MRR recovered" card relabeled into a two-line layout:
  big lifetime number on top, current run-rate underneath.
- Pure-function helper that computes the value given
  `(recoveries[], churnedSubscribers[], asOfDate)` — testable
  without DB.
- Cron endpoint runs once daily across all customers; safe to
  re-trigger anytime (idempotent).

## Non-goals

- **Real-time accuracy.** Stale by ≤24h is fine for a lifetime ROI
  number that changes slowly.
- **Per-recovery breakdown** in the UI. Just the aggregate.
- **Stripe-invoice-level accuracy.** We approximate retention as
  `floor((retention_end − recoveredAt) / 30 days)` rather than
  pulling actual invoice dates from Stripe. Conservative + cheap +
  good enough.
- **Backfilling historical data** beyond what's already in the DB.
  The cron will populate from existing `recoveries` rows on its
  first run.
- **Per-cohort breakdown** (e.g. "revenue saved from win-backs vs
  payment-recoveries") — defer until merchants ask for it.

## What changes

### A. Schema

New migration `src/winback/migrations/031_customer_cumulative_revenue.sql`:

```sql
ALTER TABLE customers
  ADD COLUMN cumulative_revenue_saved_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN cumulative_revenue_last_computed_at TIMESTAMPTZ;
```

- `cumulative_revenue_saved_cents`: BIGINT to be safe — at high
  retention × MRR this can exceed INT4. Default 0 so existing rows
  are valid immediately.
- `cumulative_revenue_last_computed_at`: nullable timestamp; the
  cron sets this on each run. Lets us surface "last updated X
  hours ago" in the UI later if useful, and lets the cron skip
  customers it just computed if we ever want incremental runs.
- No index. The column is read on the dashboard via the existing
  `customers` row lookup keyed by `userId`. No scan needed.

### B. Pure helper — `src/winback/lib/revenue.ts` (new)

```ts
export type RecoveryForRevenue = {
  subscriberId: string
  subscriptionId: string
  mrrCents: number
  recoveredAt: Date
}

export type SubscriberLifecycle = {
  subscriptionId: string
  recoveredAt: Date
  reChurnedAt: Date | null  // null = still subscribed
}

/**
 * Compute cumulative revenue saved from a customer's recoveries.
 *
 * For each recovery, count whole 30-day months the subscriber stayed
 * subscribed after recovery, multiply by mrrCents, sum.
 *
 * Floor to whole months — conservative; avoids crediting a
 * just-recovered subscriber with fractional value before they've
 * paid an invoice cycle.
 */
export function computeCumulativeRevenueSavedCents(
  recoveries: RecoveryForRevenue[],
  lifecycles: Map<string, SubscriberLifecycle>,
  asOf: Date,
): number
```

The lifecycles map is keyed by `subscriptionId`. The route loads
both recoveries and the latest cancellation timestamp per
subscription (one query per data source, no per-recovery roundtrip).

### C. Cron — `app/api/cron/cumulative-revenue/route.ts` (new)

Daily at 03:00 UTC (added to `vercel.json`).

For each customer:
1. Pull all `recoveries` rows for this customer.
2. Pull all `wb_churned_subscribers` rows for this customer where
   `cancelledAt IS NOT NULL` — these are the re-churn events.
3. Build the lifecycles map: for each recovered subscription,
   find the latest cancelledAt > recoveredAt (or null = still
   subscribed).
4. Call `computeCumulativeRevenueSavedCents` (helper above).
5. Update `customers.cumulative_revenue_saved_cents` and
   `cumulative_revenue_last_computed_at`.

Authentication: `CRON_SECRET` header (existing pattern).

Backfill on first run: just runs the same code path; rows with no
recoveries get 0; rows with recoveries get the right value. No
separate backfill script needed.

### D. Dashboard — relabel + new line

`app/dashboard/dashboard-client.tsx`, the "MRR recovered" `StatCard`
on both win-back and payment-recovery KPI bands becomes a two-line
card:

```
┌─────────────────────────────────────┐
│  $4,820                             │  ← big: cumulative_revenue_saved_cents
│  $480/mo currently active           │  ← small: existing allTime.mrrRecoveredCents
│  ─                                  │
│  REVENUE SAVED · LIFETIME           │  ← label
└─────────────────────────────────────┘
```

- Big number = `customers.cumulative_revenue_saved_cents` (read
  via existing customer row lookup; no extra query).
- Small line = `stats.{cohort}.allTime.mrrRecoveredCents` (the
  current value — explicitly labeled "currently active" so it's
  unambiguous).
- Label "REVENUE SAVED · LIFETIME" (was "MRR RECOVERED") removes
  the ambiguity about whether it's one-time or run-rate.

The card lives in the same grid slot, same accent color per cohort.

### E. API surface

Add to `/api/stats` response (under `winBack` and `paymentRecovery`):

```ts
cumulativeRevenueSavedCents: number,    // from cached column
cumulativeRevenueLastComputedAt: string | null,  // ISO timestamp
```

The cron writes the lifetime total per **customer**, not per cohort.
For v1 we surface the same total under both `winBack` and
`paymentRecovery` (same number on both tabs). A future spec can split
by cohort if merchants want it.

(Initial reading: showing the same lifetime number on both tabs is
honest — "$X total revenue Winback has saved you" is a single fact;
splitting by cohort needs a separate calculation and a separate
column. Defer.)

## Critical files

| Path | Change |
|---|---|
| `specs/41-cumulative-revenue-saved.md` | **new** (this file) |
| `src/winback/migrations/031_customer_cumulative_revenue.sql` | **new** — adds two columns to `customers` |
| `lib/schema.ts` | Drizzle schema — add the two columns to `customers` table |
| `src/winback/lib/revenue.ts` | **new** — pure `computeCumulativeRevenueSavedCents` helper |
| `app/api/cron/cumulative-revenue/route.ts` | **new** — daily cron route |
| `vercel.json` | Add cron entry: `{ path: '/api/cron/cumulative-revenue', schedule: '0 3 * * *' }` |
| `app/api/stats/route.ts` | Read the cached column from the customer row; include in response |
| `src/winback/lib/types.ts` | Add `cumulativeRevenueSavedCents` + `cumulativeRevenueLastComputedAt` to `Stats` type |
| `app/dashboard/dashboard-client.tsx` | Replace single-line "MRR recovered" with two-line "Revenue saved · lifetime" card on both KPI bands |
| `src/winback/__tests__/revenue.test.ts` | **new** — covers the pure helper |

## Edge cases

1. **Customer with zero recoveries** — helper returns 0, column
   stays at 0. Card shows `$0` cumulative + `$0/mo currently active`.
2. **Recovery happened today** — `floor((today - recoveredAt) / 30)
   = 0`. Cumulative contribution is 0 until 30 days have passed. Good
   — avoids crediting Winback before the customer has actually been
   billed.
3. **Subscriber recovered, then re-churned 10 days later** — 10 days
   < 30, contributes 0. Honest: they didn't pay another invoice.
4. **Subscriber recovered, then re-churned 95 days later** — 95/30
   = 3.16 → floor → 3 months. Contributes `3 × mrrCents`.
5. **Subscriber recovered multiple times** (recovered, re-churned,
   recovered again) — each `recoveries` row is a separate event
   with its own `recoveredAt`; we sum them. Retention end for each
   is the next re-churn event after that recovery, not necessarily
   the latest.
6. **MRR changed mid-retention** (subscriber upgraded their plan
   after recovery) — we use the `mrrCents` recorded at recovery
   time. Slight underestimate if they upgraded, slight overestimate
   if they downgraded. Acceptable — exact tracking would require
   per-invoice audit which is out of scope.
7. **Cron fails or hasn't run yet** — column reads as the last good
   value (or 0 on a brand-new tenant). UI surfaces the value as-is;
   future polish can show "last updated X hours ago" using the
   `cumulative_revenue_last_computed_at` timestamp.
8. **Customer churns from Winback itself** (downgrades / disconnects
   Stripe) — column stays at last computed value. Not relevant to
   recompute. If the customer reconnects, the cron picks them up
   normally on its next run.
9. **Cron runs while a recovery is happening concurrently** — the
   newly recovered row contributes 0 anyway (recoveredAt = now;
   floor((now - now) / 30) = 0), so race-condition is benign. Next
   day's cron picks it up correctly.
10. **Fresh tenant, dashboard loaded before first cron run** —
    column is 0 (default), card shows `$0` cumulative. Acceptable;
    the cron will populate within 24 hours. Optional polish: trigger
    the cron once after onboarding completes.

## Tests

### Pure helper (`src/winback/__tests__/revenue.test.ts`)

```ts
describe('computeCumulativeRevenueSavedCents', () => {
  it('returns 0 with no recoveries')
  it('returns 0 when only recovery happened today')
  it('counts whole months only (29 days = 0, 30 days = 1, 95 days = 3)')
  it('handles a still-subscribed recovery (lifecycles entry has reChurnedAt = null)')
  it('handles a re-churned recovery (uses reChurnedAt as retention end)')
  it('handles multiple recoveries for the same customer')
  it('uses recovery-time mrrCents (does not chase plan changes)')
  it('handles the rebuild case: recovered → re-churned → recovered again (each segment counted independently)')
})
```

### Cron route — manual verification (no integration test for v1)

- Hit the route locally with `?dryRun=1` (returns the values it
  would write without writing them).
- Verify dashboard reads the new column after a successful run.

### `/api/stats`

Existing tests stay green. Optional: add one test that asserts
`cumulativeRevenueSavedCents` is included in the response (reads
from the customer row).

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — new revenue.test.ts passes; existing
      496 still pass
- [ ] Migration applied to local Neon (`psql` query confirms
      column exists with default 0)
- [ ] Cron route hit locally with `CRON_SECRET` header and
      `?dryRun=1` — returns sane values for the demo seed
- [ ] Cron route hit locally without `dryRun` — writes
      values to DB; second run is idempotent (same values)
- [ ] Dashboard click-through on Vercel preview:
  - [ ] Card now reads "REVENUE SAVED · LIFETIME"
  - [ ] Big number matches what the cron computed
  - [ ] Small "currently active" line matches existing
        `allTime.mrrRecoveredCents`
  - [ ] Both win-back and payment-recovery tabs show the same
        cumulative number (per §E note)

## Out of scope (future)

- Per-cohort split of cumulative revenue saved (would need a
  separate calculation + column).
- "Last updated X hours ago" subtitle on the card.
- Real-time updates via webhook on every recovery / re-churn.
- Cohort retention curves ("of customers we recovered in
  January, what % are still subscribed today?").
- Pulling actual Stripe invoice dates for higher accuracy
  than `floor(days/30)` months.
- Backfill polish: trigger the cron once at onboarding so new
  tenants don't see 0 for up to 24 hours.

# Spec 45 — Cohort retention: are recovered customers sticking?

**Phase:** Dashboard depth — answers a question merchants WILL ask
**Depends on:** Spec 41 (cumulative revenue saved — establishes the
recovery+lifecycle data plumbing this spec extends)
**Estimated time:** ~half a day + tests

---

## Context

Spec 41 surfaced lifetime "revenue saved" — a real ROI number. But
it doesn't answer the merchant's natural follow-up: **"of the
customers Winback recovered, how many are still subscribed today?"**

Without that signal, a merchant 6 months in is left wondering:
- If 80% are still active, Winback is delivering durable saves.
- If 40% are still active, half our "recoveries" were 30-day delays
  of inevitable churn — much weaker product story.

Either way, the merchant deserves to know — and so do we, for
product feedback. The 14-day refund window (Spec 23) only catches
the worst-case quick re-churn. Beyond that, retention is invisible.

The data plumbing exists: Spec 41's daily cron already builds a
`SubscriberLifecycle` map per customer (`subscriptionId →
reChurnedAt | null`) for the cumulative revenue calculation. We're
adding one new aggregation that uses the same data: count of
recoveries where the lifecycle's `reChurnedAt` is null (still
active).

## Goals

- New cached column on `wb_customers`: `recoveries_still_active_count`
  + `recoveries_total_count` (denominator).
- Computed daily by the existing Spec 41 cron — same data pull, one
  more pass over the lifecycles map.
- Surface as a small line on the **Revenue saved · lifetime** card:
  "X of Y recovered subscribers still active (Z%)".
- Same number on both Win-backs and Payment recoveries tabs (per
  Spec 41 §E rationale — single ROI figure across cohorts).

## Non-goals

- **Per-cohort retention split** (win-back vs payment-recovery
  separately). Future spec if merchants ask.
- **Time-bucketed retention** ("of customers recovered in Q1, X%
  still active"). Cohort retention curves are a separate analytics
  surface; this spec is the headline number.
- **Real-time accuracy.** ≤24h stale (matches Spec 41's cron
  cadence).
- **Drill-down** ("show me which recovered customers re-churned").
  Future.
- **Counting partial recoveries** (subscriber recovered then changed
  plan). The lifecycles map already keys on `subscriptionId`; plan
  changes within the same subscription don't reset the counter.

## What changes

### A. Schema — extend Spec 41's columns

Migration `032_customer_recoveries_still_active.sql`:

```sql
ALTER TABLE wb_customers
  ADD COLUMN recoveries_still_active_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN recoveries_total_count        INTEGER NOT NULL DEFAULT 0;
```

Both INTEGER (not BIGINT) — counts of recoveries are bounded by
recovery row count which is INTEGER throughout the schema.

No new indexes — read on dashboard via existing customer row
lookup.

### B. Pure helper — `src/winback/lib/revenue.ts`

Add alongside `computeCumulativeRevenueSavedCents`:

```ts
export function countRecoveriesStillActive(
  recoveries: RecoveryForRevenue[],
  lifecycles: Map<string, SubscriberLifecycle>,
): { stillActive: number; total: number }
```

Logic: for each recovery, look up its subscription in the
lifecycles map. "Still active" means `reChurnedAt` is null OR
`reChurnedAt < recoveredAt` (an old re-churn that predates this
recovery — the same "ignore older lifecycle event" rule from
`computeCumulativeRevenueSavedCents`).

Edge case: a subscription recovered → re-churned → recovered again
counts the **second** recovery as still active (per the lifecycle
map's "latest re-churn" semantics, the post-rebuild segment is
still subscribed).

### C. Cron — extend `/api/cron/cumulative-revenue/route.ts`

Same data pull. Just call the new helper alongside
`computeCumulativeRevenueSavedCents` and write both columns in the
UPDATE.

```ts
const cents = computeCumulativeRevenueSavedCents(recoveryRows, lifecycles, asOf)
const { stillActive, total } = countRecoveriesStillActive(recoveryRows, lifecycles)
await db.update(customers).set({
  cumulativeRevenueSavedCents: cents,
  recoveriesStillActiveCount: stillActive,
  recoveriesTotalCount: total,
  cumulativeRevenueLastComputedAt: asOf,
})...
```

Renaming the cron route is tempting (it now does more than just
revenue) but not worth the breaking change to `vercel.json` and
existing CRON_SECRET configs. Leave as-is; comment-doc the
expanded scope.

### D. `/api/stats` — surface the counts

Read the two new columns from the existing customer row select.
Emit at the top level (alongside `cumulativeRevenueSavedCents`):

```ts
recoveriesStillActiveCount: number
recoveriesTotalCount: number
```

### E. Dashboard — add the retention sub-line

[app/dashboard/dashboard-client.tsx](app/dashboard/dashboard-client.tsx)
— "Revenue saved · lifetime" StatCard already has a `subValue`
slot. Currently shows "$X/mo currently active" (run-rate MRR).

Add retention as a **second** sub-line. Either:

- **Stack approach**: extend `StatCard` to accept `subValue`
  array (or a second `subValue2` prop). Two short lines under the
  big number.
- **Combined approach**: replace the run-rate sub-line with a
  combined "X of Y recovered still active · $Z/mo run-rate" — one
  line, denser.

Prefer the **stack approach** — two separate facts deserve two
separate lines. The combined version reads as a wall of text.

Visual on the card:
```
$4,820                         ← big number
Revenue saved · lifetime       ← descriptor (Spec 41)
12 of 18 recovered still active (67%)  ← NEW retention line
$480/mo currently active       ← existing run-rate
```

Hide the retention line when `recoveriesTotalCount === 0` (don't
show "0 of 0 still active" — looks broken).

## Critical files

| Path | Change |
|---|---|
| `specs/45-cohort-retention-metric.md` | **new** (this file) |
| `src/winback/migrations/032_customer_recoveries_still_active.sql` | **new** — adds two INTEGER columns to `wb_customers` |
| `lib/schema.ts` | Add the two columns to `customers` |
| `src/winback/lib/revenue.ts` | Add `countRecoveriesStillActive` pure helper alongside the existing `computeCumulativeRevenueSavedCents` |
| `app/api/cron/cumulative-revenue/route.ts` | Call the new helper; UPDATE the two new columns alongside the cents column |
| `app/api/stats/route.ts` | Select the two new columns from the customer row; emit at top of `Stats` |
| `app/dashboard/dashboard-client.tsx` | `StatCard` gains a second sub-line slot (or array); render retention line on the Revenue saved card on both tabs; `Stats` interface + `EMPTY_STATS` |
| `src/winback/__tests__/revenue.test.ts` | New tests for `countRecoveriesStillActive` covering: zero recoveries, all still active, all re-churned, recovered → re-churned → recovered (rebuild case counts as still active), older-re-churn-than-recovery edge case |

No other files. No new env vars.

## Edge cases

1. **Customer with zero recoveries** → both counts are 0; UI hides
   the retention line.
2. **All recovered customers still subscribed** → "N of N (100%)".
3. **All recovered customers re-churned** → "0 of N (0%)" — surface
   it; that's signal the merchant needs.
4. **Subscriber recovered → re-churned → recovered again** — the
   lifecycle map's `reChurnedAt` is the BETWEEN re-churn (older
   than the second recovery), so the second recovery's segment
   counts as still active. Same logic as
   `computeCumulativeRevenueSavedCents`.
5. **Plan change post-recovery** (e.g., upgrade) — same
   subscriptionId, no new churn event, counted as still active.
   Correct.
6. **Recovery happened today, no time to re-churn** — counted as
   still active (lifecycle has no later cancellation event).
   Conservative-correct.
7. **First cron run after migration** — values default to 0 until
   the cron runs (within 24h). Brand-new tenants see "—" or hide
   the line; existing tenants will see real values once the cron
   runs.
8. **Float percentages on small samples** — `Math.round((n/d)*100)`,
   no special handling needed (Math.round is fine for whole-percent
   display). 1 of 3 = 33%, not "33.33%".

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — new revenue.test.ts cases pass; existing
      tests still green
- [ ] Migration applied to local Neon
- [ ] Cron route hit locally with `?dryRun=1` then real run —
      verify both columns populate
- [ ] Hand cross-check on demo data:
      ```sql
      SELECT customer_id,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM wb_churned_subscribers c
          WHERE c.stripe_subscription_id = (
            SELECT stripe_subscription_id FROM wb_churned_subscribers
            WHERE id = recoveries.subscriber_id
          )
          AND c.cancelled_at > recoveries.recovered_at
        )) AS still_active
      FROM wb_recoveries
      GROUP BY customer_id;
      ```
- [ ] Dashboard click-through: retention line renders on both tabs
      under the run-rate; hidden when zero recoveries
- [ ] Mobile: retention line wraps cleanly under the run-rate

## Out of scope (future)

- Per-cohort split (win-back retention vs payment-recovery retention)
- Time-bucketed cohort curves ("Q1 cohort: 80% still active; Q2: 65%")
- Drill-down listing recovered subscribers who re-churned
- Median time-to-rechurn ("recovered customers stay an average of
  X months after recovery")
- Predictive: "subscribers showing low engagement post-recovery"
- Real-time updates via Stripe webhook (vs daily cron)

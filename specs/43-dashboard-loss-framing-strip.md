# Spec 43 — Dashboard loss-framing pipeline strip

**Phase:** Dashboard polish / ROI clarity (continuation of Spec 41)
**Depends on:** Spec 39 (KPI split), Spec 40 (cohort tabs), Spec 41
(cumulative revenue saved)
**Estimated time:** ~half a day + tests

---

## Context

The dashboard today answers "how much did Winback save?" via four
KPI cards per cohort (Recovery rate, Recovered, Revenue saved, In
progress / In dunning). What it doesn't answer — and what merchants
actually ask first — is "how much am I losing, and how much is being
defended?"

Without that denominator, "Revenue saved · lifetime: $4,820" reads
as additive savings on top of an unmeasured baseline. The same
$4,820 framed as "of $14,200 churned this period, $4,820 recovered
+ $8,400 in flight + $980 lost" reads as defense against a
quantified loss — which is the gut-level reason a merchant pays
$99/mo + 1× MRR.

This is a layout + copy reframe, not a new metric. The numbers all
exist in the database today; we're just composing them into a
pipeline view that sits above the existing KPI band.

## Goals

- New pipeline strip per cohort, above the KPI band on each tab.
- Shows churned MRR (the stake) + recovered + in-flight + lost
  breakdown (the defense), all in MRR cents.
- Window: rolling **last 30 days** (matches "Recovery rate (30d)"
  to keep the dashboard's time semantics consistent).
- Visually quiet — does not compete with the KPI band for the eye's
  primary attention; provides context for the deep-dives below.
- Pipeline math always balances: `recovered + in_flight + lost =
  churned`. If it doesn't, the strip lies and merchants will notice.

## Non-goals

- **Cross-cohort summary strip** at the very top of the dashboard
  (above the tab switcher). Tempting but adds an information layer
  that conflicts with the per-tab structure. Defer; revisit if
  merchants ask for "total churn across both products."
- **Charts / time-series** — sparkline already covers trend on the
  Recovered card. The pipeline strip is a snapshot, not a trend.
- **Per-segment drill-down** (clicking "in flight" doesn't filter
  the table to those rows). Future spec.
- **Counts in addition to dollars** — pipeline is dollar-flow, the
  KPI band already shows counts. One number per number.
- **Exporting the pipeline data** (CSV, PDF, etc.). Future.

## What changes

### A. Pipeline strip component

New small component in `app/dashboard/dashboard-client.tsx` (or
extracted if the file gets too long; current file is already large).

Two-line layout, single horizontal block:

```
┌──────────────────────────────────────────────────────────────────┐
│  $14,200 churned in the last 30 days                             │
│  $4,820 recovered  ·  $8,400 in flight  ·  $980 lost             │
└──────────────────────────────────────────────────────────────────┘
```

Visual treatment:
- Light slate background (`bg-slate-50`), no card border, rounded
  corners.
- First line: `text-sm text-slate-700`, the "stake" — leads with
  the dollar amount.
- Second line: `text-xs text-slate-500 tabular-nums`, the
  breakdown — `recovered` / `in flight` / `lost` separated by `·`.
- No accent colors (green/amber/red) — keep the strip tonally
  quieter than the KPI band so the eye knows what's primary. The
  KPI band carries color; this strip is context.

Renders only when there's data: if `churned = 0` in the window,
hide the strip entirely (don't show "$0 churned in the last 30
days" — looks broken).

### B. Position in the dashboard

Above the KPI band, below the tab switcher (and below the handoff
alert if shown). The merchant's reading order becomes:

1. Tab switcher (which cohort)
2. Handoff alert (if any — what to act on now)
3. **Pipeline strip (NEW — what's at risk)**
4. KPI band (segment metrics)
5. Pattern strip (causal context)
6. Subscriber table (row-level)

### C. `/api/stats` extensions

Add four new fields under both `winBack` and `paymentRecovery`:

```ts
pipeline30d: {
  churnedMrrCents: number,
  recoveredMrrCents: number,
  inFlightMrrCents: number,
  lostMrrCents: number,
}
```

Implementation: extend the existing `wbCounts` / `pCounts` queries
that already establish the rolling 30-day cohort. Add `SUM(mrr_cents)
FILTER (...)` clauses for each segment.

#### C.1 Win-back pipeline query

Same `winBackBaseWhere` + 30-day window already used for
`cohort30d` / `recovered30d`:

```sql
SUM(mrr_cents) FILTER (WHERE cancelled_at >= $window) AS churned_mrr_cents,
SUM(mrr_cents) FILTER (WHERE cancelled_at >= $window AND status = 'recovered') AS recovered_mrr_cents,
SUM(mrr_cents) FILTER (WHERE cancelled_at >= $window AND (status IN ('lost','skipped') OR do_not_contact = true)) AS lost_mrr_cents,
-- in_flight = churned - recovered - lost (computed in route, not SQL)
```

Bucket definitions match Spec 40's filter-chip semantics:
- **Recovered**: `status = 'recovered'`
- **Lost**: `status IN ('lost', 'skipped') OR do_not_contact = true`
  (matches the existing "Done" filter chip — `'skipped'` and
  `do_not_contact` count as "won't be pursued" → lost from a
  billing perspective)
- **In flight**: everything else in the cohort window. Compute as
  `churned - recovered - lost` in the route (cleaner than another
  SQL filter; ensures the math always balances).

#### C.2 Payment-recovery pipeline query

Same `paymentBaseWhere` + 30-day window, anchored on `created_at`
(payment-recovery rows don't have `cancelled_at`):

```sql
SUM(mrr_cents) FILTER (WHERE created_at >= $window) AS churned_mrr_cents,
SUM(mrr_cents) FILTER (WHERE created_at >= $window AND status = 'recovered') AS recovered_mrr_cents,
SUM(mrr_cents) FILTER (WHERE created_at >= $window AND (dunning_state = 'churned_during_dunning' OR status = 'lost')) AS lost_mrr_cents,
```

In flight = churned - recovered - lost (computed in route).

Bucket definitions match Spec 40's payment-recovery filter chips:
- **Recovered**: `status = 'recovered'`
- **Lost**: `dunning_state = 'churned_during_dunning' OR status = 'lost'`
- **In flight**: everything else (`awaiting_retry`,
  `final_retry_pending`, etc.)

### D. Dashboard wiring

In `app/dashboard/dashboard-client.tsx`, add the `Stats` interface
fields (`pipeline30d`) and the empty-state defaults. Render the
new component on each tab between the handoff alert and the KPI
band. Format MRR via existing currency formatter; respect the
existing tabular-nums class for column alignment.

## Critical files

| Path | Change |
|---|---|
| `specs/43-dashboard-loss-framing-strip.md` | **new** (this file) |
| `app/api/stats/route.ts` | Add 3 new SUM-FILTER columns to both `wbCounts` and `pCounts` queries; compute `inFlightMrrCents` in JS; emit new `pipeline30d` object under each cohort. Type updates on the inline `Stats` type. |
| `app/dashboard/dashboard-client.tsx` | New `PipelineStrip` component (or inline JSX); render above the KPI band on each tab; `Stats` interface gains `pipeline30d` per cohort; `EMPTY_STATS` defaults. |
| `src/winback/__tests__/stats-aggregation.test.ts` | If we extract the in-flight computation into a helper (e.g. `computeInFlightCents(churned, recovered, lost)`) for testability — single test confirming `churned - recovered - lost = inFlight` and that negative values clamp to 0. |

No schema changes. No new env vars. No migration.

## Edge cases

1. **Zero churn in the window** → hide the entire strip (don't show
   "$0 churned in the last 30 days" — looks broken). Brand-new
   tenant should not see this strip at all on day 1.
2. **`recovered + lost > churned`** (theoretically impossible since
   they're subsets of the same cohort, but defensive) → clamp
   `inFlightMrrCents` to 0; never render a negative number.
3. **Float precision** in MRR sums — use BIGINT in SQL (`SUM(mrr_cents)::bigint`)
   and `Number()` in JS. Same pattern as the existing
   `mrrRecoveredCents` column.
4. **Cohort entirely lost** (e.g., `recovered=0, in_flight=0, lost=$X`)
   → still render the strip; that IS the loss-framing message ("you
   lost $X this month, none recovered"). Acts as a wake-up call.
5. **Cohort entirely recovered** (`lost=0, in_flight=0`) → still
   render. The full "$X churned, $X recovered, $0 lost" reads as
   the win.
6. **Numbers larger than 4 digits** — format with thousands
   separators (existing `toLocaleString()` pattern). Strip should
   not wrap awkwardly at $1,000,000+ — second line stacks under
   first with `gap-y-1` if it does.
7. **Mobile width** — the second-line breakdown might wrap. Use
   `flex flex-wrap gap-x-3` so each segment can drop to a new line
   cleanly rather than truncating.
8. **The "skipped" status edge case** — `'skipped'` rolls up under
   "lost" per the bucket definition. That's intentional: from a
   merchant's billing perspective, a skipped subscriber is gone
   from Winback's pursuit. Spec calls this out so the rationale is
   visible if questioned later.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — existing 505 still pass + any new helper
      tests
- [ ] Manual click-through on Vercel preview, both tabs:
  - [ ] Pipeline strip renders above the KPI band on each tab
  - [ ] Numbers add up: `recovered + in_flight + lost = churned`
        (cross-check by hand)
  - [ ] Hidden when cohort has zero churn in 30d
  - [ ] Mobile width: second-line breakdown wraps cleanly
- [ ] DB cross-check (one psql query per cohort):
      ```sql
      -- Win-back pipeline cross-check
      SELECT
        SUM(mrr_cents) AS churned,
        SUM(mrr_cents) FILTER (WHERE status = 'recovered') AS recovered,
        SUM(mrr_cents) FILTER (WHERE status IN ('lost','skipped') OR do_not_contact) AS lost
      FROM wb_churned_subscribers
      WHERE customer_id = $cust
        AND cancelled_at >= NOW() - INTERVAL '30 days'
        AND (cancellation_reason != 'Payment failed' OR cancellation_reason IS NULL);
      ```

## Out of scope (future)

- Cross-cohort total strip at the very top of the dashboard.
- Per-segment drill-down (click "in flight" → table filtered).
- Time-series of the pipeline (e.g., monthly churn-and-recovery
  bar chart). Worth doing eventually but separate spec.
- Comparison to peers / benchmarks ("SaaS in your size class:
  18% recovery rate"). Needs more tenants first.
- Counts in addition to dollars on the strip (e.g.,
  "$14,200 / 47 customers churned"). Would compete with the KPI
  band's count. Maybe later as a tooltip on hover.

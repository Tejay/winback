# Spec 39 — Dashboard KPI split: win-backs and payment recoveries side-by-side

**Phase:** Pre-launch hardening / dashboard UX
**Depends on:** existing `recoveries` table with `recoveryType` column
populated since Spec 18 (`'win_back'`) and the dunning recovery path
(`'card_save'`)
**Estimated time:** ~half a day + tests

---

## Amendment 2026-05-02 — recovery rate is now a rolling 30-day cohort
rate, not lifetime conversion-among-decided-outcomes

The original spec defined recovery rate as `recovered / (recovered +
lost)` over all time. Two problems surfaced in practice:

1. **Subset-denominator confusion.** A merchant looking at "8
   recovered" against a cohort table of "All 22" expected 8/22 = 36%
   but saw 67%, because the formula's denominator was 8+4=12 (in-flight
   rows excluded). The math was defensible (a conversion rate among
   settled outcomes) but read as broken.
2. **Lifetime stale.** All-time numbers smear early product quality
   into today's rate. Merchants want to know "how am I doing right
   now," not "how have I done since I signed up."

**New formula** (both win-back and payment-recovery):

```
recovery_rate = recovered_in_last_30d / cohort_in_last_30d
```

Anchored on `cancelledAt` for win-back, `createdAt` for payment-recovery
(payment-recovery rows never have `cancelledAt` populated). Both arms
use the same `patternWindowStart` constant in `/api/stats` as the
30-day pattern strips, for consistency.

UI label changes from "Recovery rate" → "Recovery rate (30d)" so
merchants don't misread it as lifetime. The all-time `recovered` and
`mrrRecoveredCents` numbers in the same KPI band remain lifetime —
only the rate is windowed.

**Trade-off accepted:** rows that just entered the cohort haven't had
time to be recovered, so the rate is biased slightly low for fast-
arriving cancellations. The "In progress" KPI immediately to the
right tells the merchant how many denominator rows are still being
worked. Net: the rate stabilizes after ~2 weeks and accurately tracks
recent product performance.

The sections below describe the original Spec 39 behavior. Anywhere
the original text says "all-time recovery rate" or
"recovered / (recovered + lost)", read it as the new 30-day formula.

---

## Context

The dashboard today shows a single set of KPIs at the top of the
page — Recovery Rate, Recovered, MRR Recovered, Pending — that
combine win-backs (voluntary-cancel recoveries) and payment
recoveries (failed-payment saves) into one number. From
`app/dashboard/dashboard-client.tsx:374–402`:

```
| Recovery Rate | Recovered | MRR Recovered | Pending |
```

This obscures both stories. The two recovery types have very
different curves and value propositions:

| | Win-backs | Payment recoveries |
|---|---|---|
| Time to recover | Days → weeks | Hours |
| Pricing | 1× MRR fee per recovery | Free (covered by platform fee) |
| Trigger | Customer left voluntarily | Card just broke |
| Recovery rate (typical) | 5–15% | 60–90% |

A merchant glancing at the dashboard wants to see *both* independently:
*"How is my dunning protecting my MRR?"* and *"How is my win-back
machine doing?"* One combined number dilutes both.

The good news: **the backend already separates them.** The
`recoveries` table has a `recoveryType` column populated with
`'win_back'` (`webhook/route.ts:446, 508`) or `'card_save'`
(`webhook/route.ts:857`). We just need to split the SQL aggregate
and the UI.

## Goals

- Dashboard top section shows two clearly-distinguished KPI groups,
  one per recovery type.
- Numbers reflect what the backend already stores — no schema
  change, no event-handling rewrite.
- Visual treatment makes the two types instantly differentiable
  (icon + colour + label) so the merchant can scan in one second.

## Non-goals

- Renaming the internal `'card_save'` value to `'payment_recovery'`.
  The column is internal; the UI label says "Payment recoveries"
  regardless. Per CLAUDE.md naming canonical, internal jargon can
  stay.
- Backfilling `recoveryType` for legacy rows — every existing row
  already has it (the column has been populated since Spec 18).
- Showing time-series / charts. A separate exploration if/when needed.
- Per-recovery list views (those already exist in the subscriber
  table below the KPIs).

## What changes

### A. `/api/stats` route — split aggregates by `recoveryType` and time window

`app/api/stats/route.ts` currently returns:

```ts
{ recoveryRate, recovered, mrrRecoveredCents, pending }
```

Replace with:

```ts
{
  winBack: {
    thisMonth: {
      recovered: number,                    // recoveries created since startOfMonth (UTC)
      mrrRecoveredCents: number,            // sum of planMrrCents for those rows
    },
    allTime: {
      recovered: number,
      mrrRecoveredCents: number,
      recoveryRate: number | null,          // 0–100; null when denominator is 0
    },
    inProgress: number,                     // current state, no time window:
                                            //   churnedSubscribers where status='contacted'
                                            //   AND cancellationReason != 'Payment failed'
                                            //   (subscribers we've actively emailed; awaiting outcome)
    watching: number,                       // (optional v1.1) status='pending'
                                            //   (classified, never emailed; eligible for changelog-trigger)
  },
  paymentRecovery: {
    thisMonth: {
      recovered: number,
      mrrRecoveredCents: number,            // amount of restored billing this month
    },
    allTime: {
      recovered: number,
      mrrRecoveredCents: number,
      recoveryRate: number | null,
    },
    inDunning: number,                      // current state, no time window:
                                            //   churnedSubscribers where dunningState in
                                            //   ('awaiting_retry','final_retry_pending')
  },
}
```

Why this shape (per planning decision):
- **"This month"** is the headline so the merchant can ask *"is
  Winback earning its $99 this month?"* and pair it directly with
  the platform-fee billing cycle.
- **"All time"** is secondary — preserves the cumulative ROI story
  ("we've saved you $4,200 since you connected") and carries weight
  in the first few days of a new month when "this month" looks bare.
- **`pending` / `inDunning`** are inherently current — "right now"
  is the only meaningful answer; no time window applies.
- **`recoveryRate`** stays all-time only. Monthly recovery rate is
  noisy at small volumes (a single recovery in a slow month
  fluctuates the rate from 0% → 50%). Better to leave the rate as a
  long-window stability metric.

Implementation:
- `startOfMonth` = first day of current month at 00:00:00 UTC.
  (Document UTC explicitly; merchant-local timezone is out of scope.)
- One SQL aggregate over `recoveries` grouped by `recoveryType` with
  a `created_at >= startOfMonth` predicate for the "thisMonth"
  bucket. A second aggregate without the predicate for "allTime".
- One SQL pass over `churnedSubscribers` to derive `pending` and
  `inDunning` (current-state counts).
- Recovery rate computed in the route (recovered / (recovered + lost)
  per type, where "lost" = `churnedSubscribers.status='lost'`
  filtered by `cancellationReason` for win-back vs. by
  `dunningState='churned_during_dunning'` for payment recovery).

**Backwards compatibility:** the existing `Stats` type is consumed
only by `dashboard-client.tsx` (verify no admin-page consumer). The
route can be replaced cleanly because we control both ends.

### B. Dashboard UI — two side-by-side panels

`app/dashboard/dashboard-client.tsx:374–402` (the stat-card grid)
becomes two panels in a 2-column grid (stacked on mobile). Each
panel has three zones: **This month** (headline), **current state**
(pending / in-dunning), **All time** (secondary, smaller text).

```
┌────────  ✉  Win-backs  ────────┐  ┌──── 💳  Payment recoveries  ────┐
│                                 │  │                                  │
│  THIS MONTH                     │  │  THIS MONTH                      │
│  3 recovered  ·  $60 MRR        │  │  8 recovered  ·  $250 saved      │
│                                 │  │                                  │
│  In progress: 4                 │  │  In active dunning: 3            │
│                                 │  │                                  │
│  ALL TIME                       │  │  ALL TIME                        │
│  24 recovered  ·  $480/mo       │  │  89 recovered  ·  $4,200         │
│  Recovery rate: 32%             │  │  Recovery rate: 89%              │
└─────────────────────────────────┘  └──────────────────────────────────┘
```

Visual differentiation:
- **Win-back panel**: blue accent (matches the existing brand-blue
  `#3b82f6` used for primary CTAs); icon `MessageSquare` (already in
  use elsewhere for win-back).
- **Payment-recovery panel**: green accent (success / safety
  semantic — matches existing recovery green `text-green-700`); icon
  `CreditCard` (already in use for the payment-recovery flow).

Each panel header is a clear noun-phrase: "Win-backs" and "Payment
recoveries" — matches the merchant-facing canonical naming from PR
#55.

Typographic hierarchy:
- "This month" headline numbers — `text-3xl font-bold` (largest).
- Pending / in-dunning — `text-base font-semibold` (medium).
- "All time" line — `text-sm text-slate-500` (muted secondary).
- Section labels ("THIS MONTH", "ALL TIME") — `text-xs font-semibold uppercase tracking-widest text-slate-400`.

Internal labels:
- "Recovered" — count of completed recoveries in the window.
- "MRR" (win-back) — one month of recovered subscribers' fees that landed this month.
- "Saved" / "MRR protected" (payment recovery) — restored billing.
- "In progress" (win-back) — subscribers we've actively emailed (`status='contacted'`) and are awaiting an outcome. Excludes the passive watchlist (`status='pending'`, classified but never emailed) which is a different concept; surface separately as "Watching" in v1.1 if useful.
- "In active dunning" (payment recovery) — subscribers currently in the T1/T2/T3 sequence (current state).
- "Recovery rate" — all-time recovered / (recovered + lost) for that type. Display `—` when denominator is 0.

Empty-state handling per zone:
- New merchant with zero recoveries → "This month" reads `0 recovered · $0`, helper line below: *"We'll surface them as they land."* All-time block hidden (or also `0 recovered · $0`).
- Mid-month with no activity yet but historical wins → "This month" zeros are visible; "All time" block carries the value-prop weight.

### C. Drop the legacy 4-card grid

The single-line `Recovery Rate · Recovered · MRR Recovered · Pending`
grid is replaced by the two-panel layout. Don't keep both — the
two-panel layout fully subsumes the old data.

The "Pending" amber card → folded into the win-back panel (since
"pending" semantically meant pending-after-cancel; payment-recovery
in-flight is now a separate metric in its own panel).

## Code paths touched

| Path | Change |
|---|---|
| `specs/39-dashboard-kpi-split.md` | **new** (this file) |
| `app/api/stats/route.ts` | split aggregate by `recoveryType` + new `dunningState` filters |
| `app/dashboard/dashboard-client.tsx` | replace 4-card grid with two-panel layout; update `Stats` type |
| `src/winback/__tests__/stats-route.test.ts` | **new** — aggregate-split tests (or extend existing if present) |

No schema changes. No migration. No webhook changes. No new
dependencies.

## Edge cases

1. **Zero data on either side** — render the panel with zeros + a
   muted helper line ("No win-backs yet — we'll surface them as they
   land"). Better than hiding the panel.
2. **Recovery rate when denominator is zero** — display `—` instead
   of `0%`. Avoids the "we recovered 0% of 0 customers" read.
3. **First days of a fresh month** — "This month" reads small
   (e.g. `0 recovered · $0` on day 1) but the "All time" block
   carries the value narrative. Don't auto-hide the "This month"
   zone in slow weeks — the merchant needs the consistent layout to
   anchor on.
4. **Timezone** — month boundaries computed in UTC. A merchant in
   PST sees the new month start at 5pm local on the last day. Good
   enough for v1; merchant-local timezone is out of scope.
5. **Legacy `recoveries` rows where `recoveryType` is null** —
   shouldn't exist (column populated since Spec 18) but defensively
   group them as `'win_back'` (the original assumption) and log a
   warning.
6. **Customer who hits the route immediately after connecting (no
   data yet)** — both panels render zeros across all zones; banner
   above (Spec 38) shows "Backfill in progress".
7. **`dunningState` enum values** — check current schema; the spec
   assumes `'awaiting_retry' | 'final_retry_pending' |
   'churned_during_dunning' | 'recovered_during_dunning'`. Filter
   `inDunning` as the first two only.

## Tests

New (or extended) `src/winback/__tests__/stats-route.test.ts`:

- All zeros → `winBack: {0,0,0,—}, paymentRecovery: {0,0,0,—}`.
- Mixed recoveries → counts and MRR sums match per-type.
- Pending derivation:
  - 3 churnedSubscribers with `status='pending'` and `cancellationReason='Subscription cancelled'` → `winBack.pending = 3`.
  - 2 churnedSubscribers with `dunningState='awaiting_retry'` → `paymentRecovery.inDunning = 2`.
  - 1 with `dunningState='final_retry_pending'` → also counts in `inDunning` (= 3 total).
  - `dunningState='churned_during_dunning'` does NOT count as in-dunning.
- Recovery rate denominator zero → returns `null` or `'—'` (whichever the contract picks).
- Legacy null `recoveryType` row → grouped under win-back, console warning emitted.

UI snapshot test (or click-through verification — match existing
codebase pattern) for the two-panel layout.

## Verification

- [ ] Dashboard with only win-backs → win-back panel populated, payment-recovery panel shows zeros + helper line.
- [ ] Dashboard with only payment recoveries → mirror.
- [ ] Dashboard with both → both panels populated; visual treatments clearly distinguishable.
- [ ] Numbers match: hand-query `recoveries` table grouped by `recoveryType` and confirm UI matches.
- [ ] Numbers match for in-dunning: hand-query `churned_subscribers` filtered on `dunningState` and confirm.
- [ ] Mobile: panels stack vertically; numbers don't wrap weirdly.
- [ ] Empty-state copy reads cleanly.
- [ ] No regression on the rest of the dashboard (subscriber list, banner above, etc.).
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx vitest run` — existing 462+ tests pass plus new suite.

## Why this ships before Spec 38

Spec 38 (past-due backfill) benefits **new connects only** — it
makes the first-recovery experience faster for merchants who connect
*after* the spec lands. Spec 39 benefits **every existing
merchant** the moment it ships — they all see their two recovery
types separated immediately. Smaller PR, lower risk, broader impact.
Both specs are independent (no shared code; spec 38 touches backfill
+ webhook + banner copy, spec 39 touches stats route + KPI grid).
Order: Spec 39 → Spec 38.

## Out of scope (future)

- Time-series chart for either recovery type — separate spec.
- Per-segment KPIs (e.g. "win-backs by tier", "payment recoveries by
  decline code") — separate spec.
- Email-engagement KPIs (open rate, click rate) — separate spec.
- "First recovery" celebration banner refinements — Spec 38 covers
  the banner copy during backfill; permanent celebration logic can
  evolve separately.

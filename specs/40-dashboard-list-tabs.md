# Spec 40 — Dashboard subscriber list: tabs by recovery type

**Phase:** Pre-launch hardening / dashboard UX
**Depends on:** Spec 39 (KPI split — establishes the win-back vs
payment-recovery dichotomy at the top of the dashboard); existing
`/api/subscribers` route + filter chips; existing subscriber detail
drawer in `app/dashboard/dashboard-client.tsx`
**Estimated time:** ~1 day + tests

---

## Context

The dashboard subscriber list today shows **all churned subscribers
in a single table** with one filter set, one column set, one detail
drawer, and one search bar. After Spec 39 the dashboard top now
splits its KPIs into two cohorts — **Win-backs** and **Payment
recoveries** — but the list below still mixes them, with columns
and filters that only make sense for win-back rows.

Concrete problems with the combined list:

| Element | Today | Reality |
|---|---|---|
| **"Cancelled" date column** | Shown for all rows | Payment-recovery rows aren't really "cancelled" — the right anchor is `last_payment_failed_at` |
| **Filter chips** (`AI active`, `Needs you`, `Paused`, `Done`) | Apply to all rows | Pure win-back semantics. Payment recovery has no AI involvement |
| **`AiStateBadge`** | Rendered for every row | Only meaningful for win-back |
| **Status `'contacted'`** | One badge | Means "win-back email sent" *or* "T1/T2/T3 dunning sent" — different concepts |
| **Detail-drawer actions** (Pause AI / Handoff / Mark recovered) | Same drawer for every row | Most don't apply to payment-recovery rows |
| **Cancellation reason / tier** | Shown for all rows | Payment-recovery rows always say `'Payment failed'` and tier-2 — useless visual noise |

These are not just cosmetic — they materially mislead a merchant
trying to triage. A row that says *"Cancelled · Payment failed · AI
active"* is grammatically incoherent for a card failure.

The two cohorts also have **fundamentally different jobs**:

- **Win-back tab** is an **inbox**. Items demand attention.
  Handoffs, replies, manual recoveries. The merchant *acts* per row.
- **Payment recovery tab** is a **monitoring view**. The dunning
  sequence runs automatically. The merchant mostly wants reassurance
  + visibility, not per-row interaction.

Conflating them in one table is what produces the muddle.

## Goals

- Two clearly-separated tabs above the subscriber list, mirroring
  the KPI split at the top of the page.
- **Win-back tab**: action-first surface, with a "Needs you"
  attention queue, a small cancellation-pattern strip, and a list
  optimised for triage (handoffs/replies float to the top).
- **Payment recovery tab**: simpler monitoring surface. No per-row
  drawer. In-place row expansion for the rare case the merchant wants
  more detail.
- Each tab has its own scoped search, its own filter chips, its own
  empty-state copy.
- One detail-drawer component, used only on the win-back tab.

## Non-goals

- **Time-series charts** for either tab — separate work if needed.
- **Per-row actions on payment recovery** (manually retry / refund / mark recovered). Decided out of scope: the dunning sequence is automated; per-row buttons add complexity without value.
- **Renaming `recoveries.recoveryType`** values (`'card_save'` is internal; UI says "Payment recovery").
- **Bulk actions** (select multiple rows, batch resolve). Future spec if user demand emerges.
- **A separate drawer component for payment recovery.** One drawer (existing) used only on the win-back tab; payment-recovery rows expand in place.
- **Migrating the existing AI-state filter system** — keep it, scope it to the win-back tab only.

## What changes

### A. Tab strip above the list

`app/dashboard/dashboard-client.tsx` (just above the current
filter chip strip, ~line 480):

```
┌────────────────────────────────────────────────────────┐
│  ✉  Win-backs (12)        💳  Payment recoveries (8)   │
└────────────────────────────────────────────────────────┘
```

- Two tabs. Counts are taken from `stats.winBack.allTime.recovered + stats.winBack.inProgress` and `stats.paymentRecovery.allTime.recovered + stats.paymentRecovery.inDunning` respectively (or a dedicated `total` field; the count is "everything in this cohort regardless of status").
- Active tab: blue accent for win-back, green for payment recovery (matches Spec 39 KPI rows).
- Tab state held in `useState`; default = `'winBack'` on page load. (No URL persistence in v1; can add later if requested.)
- Each tab has independent filter / search state — switching tabs does not carry the search term over.

### B. Win-back tab

Layout, top to bottom:

```
┌────────────────────────────────────────────────────────────────┐
│  ⚠  3 subscribers need your attention  →  [Resolve queue]      │  ← shown only when count > 0
└────────────────────────────────────────────────────────────────┘

Top reasons this month:
Price (32%) · Features (24%) · Switched (18%) · Other (26%)        ← always present, muted small text

[ All  •  Needs you (3)  •  Has reply (2)  •  Paused  •  Recovered  •  Done ]

[ search box  ]                  Default sort: Needs you → Has reply → Recency

[ subscriber rows … ]
```

#### B.1 Handoff alert

New small component (or inline in dashboard-client.tsx). Renders
only when `winBack.handoffsNeedingAttention > 0`.

- Visual: amber background (matches the existing "Pending" amber
  semantic), warning icon, count, "Resolve queue" CTA that sets the
  filter chip to `'handoff'`.
- Hides itself entirely when count is 0 (true inbox-zero).
- Counts come from a new field on `/api/stats`:
  `winBack.handoffsNeedingAttention` = `churnedSubscribers` where
  `founderHandoffAt IS NOT NULL AND founderHandoffResolvedAt IS NULL
  AND status != 'recovered' AND cancellationReason != 'Payment failed'`.

#### B.2 Cancellation-reason pattern strip

Always visible; muted small text below the alert.

- Shows top 4 cancellation categories in the **last 30 days** (grouped
  by `cancellationCategory`), with percentages.
- Window is rolling 30-day, not calendar-month — calendar-month scope
  was misleading on day 1–3 of any month (a 1-row sample renders as
  "100%" while the table below shows a clear mix).
- Comes from new `/api/stats` field:
  `winBack.topReasons: Array<{ category: string; pct: number }>`.
- Empty / sparse state: **hide the strip when fewer than 3 rows in the
  window**, not just when zero. A 1- or 2-row sample produces
  misleading percentages ("100%"), so the API returns `[]` and the UI
  hides the strip.

#### B.3 Filter chips

Existing chips stay, plus one new chip:

| Chip | Filter | Notes |
|---|---|---|
| All | none | default |
| Needs you | `founderHandoffAt IS NOT NULL AND founderHandoffResolvedAt IS NULL` | existing |
| **Has reply** (NEW) | `EXISTS (emailsSent.repliedAt IS NOT NULL FOR this subscriber)` | new |
| Paused | `aiPausedAt IS NOT NULL AND (aiPausedUntil IS NULL OR aiPausedUntil > NOW())` | existing |
| Recovered | `status = 'recovered'` | existing |
| Done | `status IN ('recovered', 'lost', 'skipped') AND aiPausedAt IS NULL` | existing |

All filters scoped to win-back cohort: `cancellationReason !=
'Payment failed' OR cancellationReason IS NULL`.

Counts shown next to chips when > 0.

#### B.4 Default sort

When chip is `'all'`:

```
ORDER BY
  CASE WHEN founderHandoffAt IS NOT NULL AND founderHandoffResolvedAt IS NULL THEN 0 ELSE 1 END,  -- handoffs first
  CASE WHEN EXISTS (replied) THEN 0 ELSE 1 END,                                                   -- then replies
  cancelledAt DESC                                                                                -- then recency
```

Other chips: just `cancelledAt DESC` (the chip already constrains the cohort).

#### B.5 Drawer (existing)

Keeps current behaviour. All existing affordances (LLM reasoning,
draft email, replies, AI state controls, mark recovered, resend)
stay. **Stop opening it for payment-recovery rows** — see §C.

### C. Payment recovery tab

Layout, top to bottom:

```
┌─────────────────────────────────────────────────────────────────┐
│  $1,240/mo at risk  ·  8 in retry  ·  3 on final attempt        │  ← summary band, always
└─────────────────────────────────────────────────────────────────┘

Top decline codes this month:
insufficient_funds (62%) · expired_card (24%) · do_not_honor (10%) · other (4%)

[ All  •  In retry (8)  •  Final retry (3)  •  Recovered  •  Lost ]

[ search box ]                                                       Default sort: most-urgent retry first

[ payment-recovery rows … ]
```

#### C.1 Summary band

Single horizontal band above the filter chips. Three numbers:

- **MRR at risk**: sum of `mrrCents` for rows where
  `dunningState IN ('awaiting_retry', 'final_retry_pending')`.
- **In retry**: count where `dunningState = 'awaiting_retry'`.
- **On final attempt**: count where `dunningState = 'final_retry_pending'`.

Comes from new fields on `/api/stats`:
`paymentRecovery.mrrAtRiskCents`, `paymentRecovery.onFinalAttempt`.
(The existing `paymentRecovery.inDunning` already covers total-in-retry.)

#### C.2 Decline-code pattern strip

Same shape as win-back's reason strip but uses `lastDeclineCode`.
Window is rolling 30-day, not calendar-month (same rationale as §B.2).

Comes from new `/api/stats` field:
`paymentRecovery.topDeclineCodes: Array<{ code: string; pct: number }>`.

Empty / sparse state: hide the strip when fewer than 3 rows in the
window.

#### C.3 Filter chips

| Chip | Filter |
|---|---|
| All | none |
| In retry | `dunningState = 'awaiting_retry'` |
| Final retry | `dunningState = 'final_retry_pending'` |
| Recovered | `status = 'recovered' AND cancellationReason = 'Payment failed'` |
| Lost | `dunningState = 'churned_during_dunning' OR (status = 'lost' AND cancellationReason = 'Payment failed')` |

All filters scoped to payment-recovery cohort:
`cancellationReason = 'Payment failed'`.

#### C.4 Row layout (informational, expandable)

Each row shows:

- Customer name + email
- MRR (formatted as `$X/mo`)
- Last failed at
- Dunning state badge (`In retry T2` / `Final attempt` / `Recovered` / `Lost`)
- Decline code badge (`insufficient_funds` etc., short label)
- Next retry date (when applicable)
- Chevron at right → expand in place

Default sort: `nextPaymentAttemptAt ASC NULLS LAST` so the most-urgent retries float to the top of the active set.

#### C.5 In-place row expansion (no drawer)

Click chevron → row expands in place to show:

- Full email-touch history (T1 sent at..., T2 sent at..., T3...)
- Full last-decline message (bank-verbose text if available)
- Stripe invoice link (external)
- Recovery info if status='recovered' (when, attribution, MRR)

Single button: `Resend update-payment email` (closes the in-place
expansion + triggers the existing dunning email send for this row).

This is the only per-row action. Otherwise the tab is purely
informational, per non-goal §2.

#### C.6 No drawer

Clicking a payment-recovery row anywhere except the chevron does
nothing. The drawer state (`selected`) only opens for win-back rows.

### D. Backend changes

#### D.1 `/api/subscribers` — add `cohort` param

Accept `?cohort=winback` or `?cohort=payment-recovery`:

- `winback`: `cancellationReason != 'Payment failed' OR cancellationReason IS NULL`
- `payment-recovery`: `cancellationReason = 'Payment failed'`
- Default (no param): same as today (returns all). Keeps backwards compat.

Existing `filter` param stays — but only the chip values relevant to
the cohort make sense per query. Frontend ensures it never passes a
chip from one cohort while in the other.

Add `?hasReply=true` filter for the new "Has reply" chip:

```sql
EXISTS (
  SELECT 1 FROM wb_emails_sent
  WHERE subscriber_id = wb_churned_subscribers.id
    AND replied_at IS NOT NULL
)
```

#### D.2 `/api/stats` — extend the response

Add fields under `winBack`:

```ts
handoffsNeedingAttention: number,                // for the alert
topReasons: Array<{ category: string; pct: number }>,  // top 4 this month
```

Add fields under `paymentRecovery`:

```ts
mrrAtRiskCents: number,                          // sum of in-retry rows
onFinalAttempt: number,                          // count where dunningState = 'final_retry_pending'
topDeclineCodes: Array<{ code: string; pct: number }>, // top 4 this month
```

The pattern aggregations are simple `GROUP BY ... ORDER BY count
DESC LIMIT 4` queries on `churnedSubscribers` filtered by the cohort
+ a rolling 30-day cutoff (`createdAt >= now − 30 days` for
payment-recovery; `cancelledAt >= now − 30 days` for win-back).
`startOfMonthUtc` stays in use elsewhere for KPI MoM deltas, where
calendar-month semantics are correct.

Sample-size guard: the `topNFromCounts` helper accepts a `minTotal`
option; both call sites pass `{ minTotal: 3 }` so the API returns
`[]` (and the UI hides the strip) when the window contains fewer
than 3 rows.

#### D.3 No schema changes

Everything queryable from existing columns. No migration.

## Critical files

| Path | Change |
|---|---|
| `specs/40-dashboard-list-tabs.md` | **new** (this file) |
| `app/dashboard/dashboard-client.tsx` | Add tab state; split list into `WinBackTab` + `PaymentRecoveryTab` sections; new alert + pattern-strip components inline; new "Has reply" chip; default-sort logic |
| `app/api/subscribers/route.ts` | Accept `cohort` + `hasReply` query params; partition WHERE clause |
| `app/api/stats/route.ts` | Add `handoffsNeedingAttention`, `topReasons` (winBack); `mrrAtRiskCents`, `onFinalAttempt`, `topDeclineCodes` (paymentRecovery) |
| `src/winback/lib/stats.ts` | Optional helper for the pattern aggregator if logic is non-trivial |
| `src/winback/__tests__/stats-aggregation.test.ts` | Extend with tests for the new fields if any pure logic moves into `lib/stats.ts` |
| `src/winback/__tests__/subscribers-cohort.test.ts` | **new** — verifies the cohort partitioning on the subscribers route |

## Reuse / existing

- **Filter chip styling + state** — already in dashboard-client.tsx. Just scope each set to its tab.
- **`StatusBadge`, `AiStateBadge` components** — used as-is on win-back rows; not rendered on payment-recovery rows.
- **Detail drawer JSX** (~line 500+ in dashboard-client.tsx) — stays. We just gate its open state to win-back rows.
- **`startOfMonthUtc`** — existing helper from Spec 39, reused for the pattern aggregations.
- **`recoveryRatePct`** — existing helper, reused if we want recovery-rate per filter chip.
- **Existing AI-state filter logic** in `/api/subscribers` — keep; scope to win-back cohort only.
- **Existing dunning-state schema** (`awaiting_retry`, `final_retry_pending`, etc.) — already populated on every payment-recovery row; just surface in the UI.

## Edge cases

1. **Empty win-back tab + populated payment-recovery tab** (or vice versa) → render the empty-state copy specific to the tab. Don't auto-switch tabs; the merchant chose this tab. Empty state: *"No win-backs yet — they'll appear here as cancellations land."*
2. **Subscriber with zero emails sent yet (`pending` from backfill)** — appears in win-back tab; handled by existing logic.
3. **Subscriber whose `cancellationReason` is `NULL`** (legacy) → bucketed as win-back (matches the pre-Spec 39 default).
4. **Search active when switching tabs** → reset search on tab switch. Search state lives per-tab.
5. **"Resend update-payment email" on a payment-recovery row that's already `recovered`** → button hidden. Only render when `dunningState IN ('awaiting_retry', 'final_retry_pending')`.
6. **Pattern strip with fewer than 4 distinct categories** → render whatever's there. Don't pad with "Other".
7. **Pattern strip with fewer than 3 rows in the last 30 days** → hide the strip entirely. Zero rows is the obvious case, but a 1- or 2-row sample also produces misleading percentages ("100%" / "50%" with no real signal). The API returns `[]` via `topNFromCounts(..., { minTotal: 3 })` and the UI hides the strip on an empty array.
8. **Rate limit on `/api/stats`** — both tabs rely on the same poll. The new aggregations add ~3 lightweight queries; should be fine but add an index check during review (`cancellationCategory`, `lastDeclineCode`, `cancelledAt`).
9. **A win-back row that recovers but the merchant is currently on the payment-recovery tab** → row only updates on next poll; no special handling needed.
10. **Tab persistence** — none in v1. Reload starts on win-back. Acceptable trade-off; URL state can be added if user feedback demands.

## Tests

### Pure helpers (`src/winback/lib/stats.ts`)

If we add a `topNFromCounts` helper for the pattern aggregations,
test:
- Empty input → `[]`.
- Single category → 100%.
- 4+ categories → top 4 only, percentages sum to 100% (within rounding).
- Tied counts → deterministic ordering (alphabetical fallback).
- `minTotal: 3` on a 2-row sample → `[]` (sample-size guard hides strip).
- `minTotal: 3` on a 3-row sample → returns top-N as normal.

### `/api/subscribers` cohort partitioning

New `subscribers-cohort.test.ts`:
- `?cohort=winback` returns rows where `cancellationReason != 'Payment failed' OR IS NULL`.
- `?cohort=payment-recovery` returns rows where `cancellationReason = 'Payment failed'`.
- No `cohort` param → returns all (regression).
- Cohort + filter chip combined → filter applies within cohort.
- `?hasReply=true` → only rows with `emailsSent.repliedAt IS NOT NULL`.

### UI / click-through (manual)

Per verification checklist below.

## Verification

- [ ] Both tabs render with the right counts in the tab labels (cross-check against `/api/stats`).
- [ ] Switching tabs scopes the list to the correct cohort.
- [ ] Search and filter state are independent per tab (search "alice" in win-back, switch tabs, search box is empty).
- [ ] **Win-back tab:**
  - [ ] Handoff alert shows when count > 0; clicking "Resolve queue" sets the filter chip.
  - [ ] Handoff alert hides when count is 0 (verify by resolving all).
  - [ ] Pattern strip shows top 4 reasons from the last 30 days; hides when fewer than 3 rows in the window.
  - [ ] "Has reply" chip filters correctly; count badge accurate.
  - [ ] Default-sort surface order: handoffs → replies → recency.
  - [ ] Detail drawer opens on row click; existing functionality intact.
  - [ ] No payment-recovery rows leak into the win-back list.
- [ ] **Payment recovery tab:**
  - [ ] Summary band shows MRR-at-risk + in-retry + on-final-attempt counts; numbers match a hand-query.
  - [ ] Top-decline-codes strip shows top 4 from the last 30 days; hides when fewer than 3 rows in the window.
  - [ ] Filter chips work (`In retry`, `Final retry`, `Recovered`, `Lost`).
  - [ ] Default sort: most-urgent retry first (rows with the soonest `nextPaymentAttemptAt`).
  - [ ] Clicking row body does NOT open a drawer.
  - [ ] Clicking the chevron expands the row in place; clicking again collapses.
  - [ ] "Resend update-payment email" button visible only on rows with `dunningState IN (...)`; click triggers existing dunning-email path; no duplicate emails on rapid double-click (idempotency from existing index).
  - [ ] No win-back rows leak into the payment-recovery list.
- [ ] Mobile: tabs stack/scroll cleanly; row expansions don't break layout.
- [ ] Empty states render correctly per tab (test by filtering to a chip with zero matches).
- [ ] `npx tsc --noEmit` clean.
- [ ] `npx vitest run` — existing 477+ tests pass plus new suite.

## Out of scope (future)

- Time-series charts ("recovery rate over the last 90 days").
- Per-row payment-recovery actions beyond "Resend update-payment email".
- Bulk actions across rows.
- URL-state persistence for the active tab (`?tab=payment-recovery`).
- Custom decline-code filtering (e.g. "show only insufficient_funds").
- Drill-down on the pattern strips (clicking "Price" filters to that category) — would be a nice add but separate.

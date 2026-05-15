# Spec 73 — Offset pagination for the merchant dashboard

## Context

The merchant dashboard's `/api/subscribers` endpoint selects ALL churned
subscribers for a customer with no `LIMIT`. Grows with every cancellation,
forever. A merchant with a few thousand churned subs gets a massive payload
on every dashboard load.

The goal of this spec is to add **offset pagination** to `/api/subscribers`
and the dashboard client that consumes it, capping payload size and
bounding query cost.

### Scope adjustment during execution (2026-05-15)

The original spec also included `/api/improvements` (Winback Reasons archived
view). Dropped during click-through: the merchant view of "archived
improvements" is product-questionable — Winback Reasons is meant to feel
like a living document of what you've shipped, not a graveyard of past
deletes. The archived view itself is being redesigned in a follow-up
(planned Spec 74: replace "Show removed" toggle with toast-undo on
delete + 30-day hard-delete cron). Paginating a view we're about to
remove would be wasted work. Active improvements are structurally capped
at 10 (`MAX_ACTIVE_IMPROVEMENTS`), so no pagination is needed there
either.

The pagination audit on 2026-05-15 confirmed `/api/subscribers` and
`/api/improvements` were the only two unbounded list endpoints. All
`/api/admin/*` routes already have hard caps (50–500). With the
improvements redesign coming, `/api/subscribers` is the only endpoint
this spec touches.

### Why offset, not cursor

Cursor pagination is the canonical "scales better at depth" choice and the
right default for feeds (infinite scroll, no totals, no random access). The
dashboard is structurally the opposite:

- **Scale.** A merchant's churned-sub count tops out in the low thousands.
  `OFFSET 1980` on 2,000 rows still runs in single-digit ms. Cursor's
  constant-cost-at-depth advantage only starts mattering at ~100k+ rows.
- **Sort + filter combinatorics.** The dashboard has status filters, search,
  and per-cohort sort policies. Cursor pagination requires the cursor to
  encode the sort key — every sortable column multiplies the cursor-construction
  logic. Offset is sort-agnostic.
- **UX shape.** The dashboard table needs "Showing 1–25 of 940" and the
  ability to jump to a specific page. Both are structurally what offset *is*
  and structurally what cursors *can't do* without giving up their main benefit.
- **Offset's weakness barely bites.** A row inserting at the top mid-session
  could cause one row to repeat across a page boundary. Cosmetic glitch on a
  rare event; not data loss.

The falsifiable tell: if churned-sub volume could realistically hit 500k per
merchant, or if the dashboard were infinite-scroll with no filters, switch to
cursor. Neither is true.

## Goals

1. Add offset pagination to `/api/subscribers`.
2. Bound payload size + query cost per request (no more "fetch everything").
3. Dashboard UI gets a numbered page nav, total count display, and URL state
   so back-button + refresh + bookmarks work.
4. New reusable `<Pagination>` component (single consumer today, anticipated
   reuse when Spec 74 surfaces).

## Non-goals

- Cursor pagination. (See "Why offset" above.)
- Touching `/api/admin/*` — already capped, low admin volume.
- Touching `/api/improvements` or Winback Reasons UI — see scope adjustment
  in Context. Follow-up Spec 74 redesigns the Remove flow.
- Infinite scroll / virtualization. (Wrong shape for a filterable detail-drawer
  table.)
- Page-size selector. Single opinionated default (25) keeps merchant UX
  clean. `pageSize` is overridable via query param for power users / tests
  but no UI control.

## Design

### Offset model

```sql
SELECT ... FROM table
WHERE <same conditions as before>
ORDER BY ...
LIMIT $pageSize OFFSET (($page - 1) * $pageSize);

SELECT COUNT(*) FROM table
WHERE <same conditions as before>;
```

Two queries per request — the SELECT and the COUNT. Both reuse the same
WHERE clause so `total` and `rows` agree.

### Page-size policy

| Surface              | Default | Clamp range |
|----------------------|---------|-------------|
| Dashboard subscribers | 25     | [1, 100]    |

`page` is 1-indexed (matches URL + UI). Server clamps `page < 1` to 1.
Server does NOT clamp `page > maxPage` — returns empty `rows` with the real
`total` so the client can render "No subscribers on page N" gracefully and
the user can navigate back.

### API contracts

#### `GET /api/subscribers`

Existing params unchanged: `cohort`, `filter`, `search`, `hasReply`.
New params: `page` (default 1), `pageSize` (default 25).

Response:
```ts
{
  rows: Subscriber[],
  total: number,
  page: number,
  pageSize: number,
}
```

**Breaking change** from the bare `Subscriber[]` shape. The dashboard client
is updated in the same commit so the contract change is atomic.

### URL state

Dashboard: `?page=N` appended alongside existing filter/search/cohort
params. Refresh, back button, and bookmarks all work. Page 1 = no
param in URL (cleaner).

### Reset behavior (dashboard)

Client resets to `page=1` on:
- Filter change
- Search change (debounced)
- Cohort tab switch

Implemented client-side before issuing the fetch — server never receives
a stale `page=5 & new filter` combination.

### Pagination UI

New shared component `<Pagination>` (`components/pagination.tsx`):
- Props: `total`, `page`, `pageSize`, `onPageChange(page: number) => void`.
- Renders nothing when `total <= pageSize` (single-page result).
- Layout: `[Prev] [1] [2] [3] [...] [45] [46] [47] [Next]` with smart
  truncation (ellipsis when there's a gap > 1).
- Active page highlighted with `bg-[#0f172a] text-white rounded-full` per
  the project's primary-button style.
- Inactive page numbers: `border border-slate-200 bg-white text-slate-700
  rounded-full` per secondary-button style.
- "Showing X–Y of Z" text rendered above the controls
  (`text-sm text-slate-500`).
- Mobile: drops to `[Prev] Page X of Y [Next]` at < 640px width.

## Code paths touched

### API

- **`app/api/subscribers/route.ts`** — add page/pageSize parsing, COUNT
  query, LIMIT + OFFSET, new response shape.

### Dashboard

- **`app/dashboard/dashboard-client.tsx`**
  - New state: `page` (read from `useSearchParams()` on mount).
  - New state: `totalSubs` (derived from server response).
  - `fetchData` includes `?page` + `?pageSize` in the URL.
  - Resets `page = 1` on filter/search/cohort change before fetching.
  - Pushes `?page=N` to URL via `router.replace()` on page change (no
    history clutter — each filter/search/page combo replaces, doesn't
    push). Initial page picked up via `useSearchParams`.
  - Renders `<Pagination>` below the subscriber table when `totalSubs >
    pageSize`.

### Shared

- **`components/pagination.tsx`** — new file. Single consumer today
  (dashboard); anticipated reuse when Spec 74 surfaces.

### Tests

- **New: `src/winback/__tests__/subscribers-pagination.test.ts`**
  - Default page/pageSize when params omitted.
  - `pageSize` clamp to [1, 100].
  - `page < 1` clamped to 1.
  - `page` out of range returns empty `rows` with correct `total`.
  - `total` from COUNT(*) matches what the SELECT returns under the same
    filter.
  - Cohort + filter + page interaction works correctly.

## Edge cases

- **Page out of range** (e.g. `?page=999` when only 47 pages exist) — server
  returns `{ rows: [], total: 940, page: 999, pageSize: 25 }`. Client renders
  "No subscribers on page 999. Showing page 1." with a "Go to page 1" link.
  Server does NOT auto-clamp — preserves response predictability.

- **`pageSize` out of [1, 100]** — server clamps and echoes the clamped value
  in the response so the client knows what actually happened.

- **Filter/search change while on a deep page** — client resets `page = 1`
  BEFORE issuing the fetch, never sends a stale combo. Verified in test.

- **Concurrent insert during paging** — known offset weakness. A row appearing
  at the top while the merchant pages from 1 to 2 can cause one row to repeat
  across the boundary. Documented in spec, not fixed. Frequency is low (one
  cancellation per minute at most for any plausible merchant), severity is
  cosmetic, not data loss.

- **Empty result set** — `total = 0`, `rows = []`. `<Pagination>` renders
  nothing. Table shows the existing empty-state UI.

- **Cohort tab switch from a non-page-1 state** — client resets `page = 1`
  AND clears the URL `?page=` param (via `router.replace()` with the new
  cohort and no page param). Prevents "switched to payment-recovery on page
  5" weirdness.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green (existing + new pagination tests)
- [ ] `curl /api/subscribers?cohort=winback&page=1&pageSize=5` returns
      the new shape with 5 rows
- [ ] `curl /api/subscribers?cohort=winback&page=999&pageSize=5` returns
      `{ rows: [], total: <real>, page: 999, pageSize: 5 }`
- [ ] Dev server: load dashboard with 30+ churned subs → page nav appears,
      clicking page 2 fetches page 2
- [ ] Filter change while on page 2 → resets to page 1 (URL + UI)
- [ ] Search change while on page 2 → resets to page 1 (URL + UI)
- [ ] Cohort tab switch from page 2 → resets to page 1
- [ ] Browser back button after paging → returns to previous page
- [ ] Refresh on `?page=3` → still on page 3
## Phasing

Single PR (`feat/spec-73-pagination`). The API response-shape change is
breaking, but the dashboard client lives in the same repo and changes in
the same commit, so the change is atomic.

## Rollback

`git revert` the merge commit. No DB changes, no env changes, no migration.
Pure code revert restores the bare-array response shape and removes the
pagination component.

# Spec 76 — Dead-letter recovery drawer on the admin overview

## Context

Classifier dead-letter is the failure mode where a `wb_churned_subscribers`
row hits `classify_attempts >= 3` and drops out of the queue (Spec 72).
The current surface area for recovering from this is fragmented:

- `/admin` overview tile shows the **count** with a link to the events
  log (`?name=classify_dead_lettered`).
- `/admin/subscribers/[id]` inspector banner shows that **one** row is
  stuck, with a "Reset attempts" button (existing endpoint
  `/api/admin/subscribers/[id]/reset-classify`).
- Nothing surfaces a **list** of stuck subscribers in one place.

Recovery flow today: admin sees count → clicks "investigate →" → lands
on the events page → squints at the log → clicks into each subscriber
individually → resets. For 12 subscribers stuck overnight from a prompt
regression, that's ~50 clicks of friction during an incident.

### Why a drawer, not a new page

Considered four shapes (recapped from the design discussion):

1. **Dedicated `/admin/dead-letter` page** — permanent nav surface for a
   rare ops flow. Overbuilt.
2. **Drawer from the overview tile** — opens where the admin discovers
   the problem; no new nav; the flow lives where the entry point is.
3. **Filter chip on `/admin/subscribers`** — reuses bulk-action infra
   but requires navigating to a different page first.
4. **Status quo** — events page + per-subscriber resets. Clunky.

(2) wins because it's where the admin already is, requires no new
permanent surface, and the dead-letter recovery flow has a clear single
entry point (the overview tile) rather than being a general lookup.

## Goals

1. Click the dead-letter tile on `/admin` → drawer opens showing every
   currently dead-lettered subscriber.
2. Each row in the drawer shows enough context to triage (email, plan,
   last error message, customer/founder, classify_attempts).
3. Each row has a **Reset attempts** button that reuses the existing
   `/api/admin/subscribers/[id]/reset-classify` endpoint.
4. The drawer auto-refreshes after a successful reset so the row drops
   out of the list immediately.

## Non-goals

- **Bulk reset action.** Skip for v1. At expected volumes (handful of
  stuck rows per incident), per-row reset is fast enough. Add bulk
  later if we hit a 50+ stuck-rows incident.
- **Filtering / sorting / search within the drawer.** It's a flat list
  of < ~50 items in the worst case. Default ordering by `updated_at
  desc` so the freshest failures are at the top.
- **Pagination.** Same reason — volume is bounded by "how many failed
  3+ times since the cron last ran", which can't exceed the cron's
  batch size in a single run. Practically < 50.
- **A new permanent nav entry.** Drawer-only.
- **Changing the existing tile behavior when count = 0.** Zero-state
  stays unchanged ("history →" link to events).

## Design

### UI

The `DeadLetterTile` component on `/admin` is extended:

- **Count = 0**: unchanged.
- **Count ≥ 1**: the existing tile becomes a button-shaped clickable
  element. Click opens a side drawer (right edge, ~480px wide on
  desktop; full width on mobile).
- The "investigate →" history link to the events page is **kept** as a
  smaller secondary action below the main button, so admins who want
  raw event archaeology still have the path.

### Drawer contents

Header:
- Title: "Dead-lettered subscribers"
- Subtitle: "N stuck — reset attempts to put them back in the queue."
- Close button (X) in the top-right.

Body — for each stuck subscriber:
- Email + founder name + product (line 1)
- Plan name + MRR + tenure (line 2, small text)
- Last error message from the most recent `classify_failed` event
  (truncated to 120 chars, full message on hover via title attr)
- `classify_attempts` count (e.g., "3 attempts")
- **Reset** button (right side)

Footer:
- Link to `/admin/events?name=classify_dead_lettered` for full event
  history if needed.

### Behavior

- Drawer opens → fires `GET /api/admin/dead-letter-list` → renders rows.
- Click Reset on a row → fires `POST
  /api/admin/subscribers/[id]/reset-classify` (existing endpoint).
- On success: row disappears from the drawer; if the list is now
  empty, drawer shows "Queue cleared 🎉" and closes itself after 1.5s.
- On failure: inline error on the row, row stays.
- Closing the drawer triggers a refresh of the parent overview so the
  count reflects the resets.

### Empty state

If `GET /api/admin/dead-letter-list` returns zero rows (e.g., another
admin reset them in a different tab between the count fetch and the
drawer open), the drawer shows "No stuck subscribers right now" and a
"Close" button.

## API contracts

### New: `GET /api/admin/dead-letter-list`

Returns the list of currently dead-lettered subscribers across **all**
merchants (admin-scoped — no customer narrowing).

```ts
{
  rows: Array<{
    id:                 string  // subscriber UUID
    customerId:         string
    customerEmail:      string | null  // founder email
    customerProductName: string | null
    email:              string | null
    name:               string | null
    planName:           string | null
    mrrCents:           number
    classifyAttempts:   number
    updatedAt:          string  // ISO
    lastError:          string | null  // most recent classify_failed errorMessage
  }>
  total: number
}
```

Query shape:
```sql
SELECT s.*, c.product_name, u.email AS founder_email
FROM wb_churned_subscribers s
JOIN wb_customers c ON c.id = s.customer_id
JOIN wb_users u ON u.id = c.user_id
WHERE s.classified_at IS NULL AND s.classify_attempts >= 3
ORDER BY s.updated_at DESC
LIMIT 100  -- soft cap, not paginated
```

The `lastError` field requires a second query against `wb_events` for
each subscriber, OR a single JOIN if we want to fetch the most recent
`classify_failed` event per subscriber. Simpler: a LATERAL JOIN
(Postgres) or a subquery. Implementation will use LATERAL for clarity:

```sql
LEFT JOIN LATERAL (
  SELECT properties->>'errorMessage' AS msg
  FROM wb_events
  WHERE name = 'classify_failed'
    AND properties->>'subscriberId' = s.id::text
  ORDER BY created_at DESC
  LIMIT 1
) last_err ON true
```

Auth: `requireAdmin()` (standard admin gate).

### Existing: `POST /api/admin/subscribers/[id]/reset-classify`

Unchanged. Already works for the per-subscriber reset flow on the
inspector. The drawer reuses this endpoint.

## Code paths touched

### API

- **New: `app/api/admin/dead-letter-list/route.ts`** — GET handler.
  Auth check, read-only DB query, return rows.

### Admin UI

- **`app/admin/overview-client.tsx`** — `DeadLetterTile` becomes
  clickable when `count >= 1`. Opens a drawer (new state in the parent
  component or local to the tile).

- **New: `app/admin/dead-letter-drawer.tsx`** — drawer component.
  Fetches list, renders rows, handles per-row reset, closes on
  success.

### Tests

- **New: `src/winback/__tests__/admin-dead-letter-list.test.ts`** —
  API tests:
  - Returns rows with `classified_at IS NULL AND classify_attempts >= 3`
  - Joins to customers + users for context
  - Includes `lastError` from most recent `classify_failed` event
  - Auth: 401 for unauthenticated, 403 for non-admin
- Existing `admin-reset-classify.test.ts` stays as-is (endpoint unchanged).

## Edge cases

- **Concurrent admin actions** — two admins reset the same row from
  different tabs. The reset endpoint already returns 200 if attempts
  is already 0 (idempotent). Drawer drops the row regardless.
- **A row's classifier_failed has no errorMessage property** — show
  "(no error message)" or fall back to a generic "classification
  failed 3 times".
- **A subscriber has matches in `wb_improvement_matches` already** —
  irrelevant to dead-letter; we're just resetting classify_attempts.
- **Drawer open while overview auto-poll fires** — refreshes count in
  background but doesn't disturb the drawer. Drawer holds its own
  state.
- **Hard cap of 100 rows** — if the queue ever exceeds this (would
  indicate something catastrophic), show "Showing first 100 — N more
  in queue (drill in via events page)" at the bottom.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green (existing + new dead-letter-list test)
- [ ] Dev server: seed 3 dead-lettered rows via SQL (set
      classify_attempts = 3 + classified_at = NULL) → overview tile
      shows count → click → drawer opens with all 3 rows
- [ ] Each row shows email, plan, MRR, classify_attempts, last error
- [ ] Click Reset on one row → row vanishes from drawer; overview
      count drops on next refresh
- [ ] Reset all 3 → "Queue cleared 🎉" → drawer auto-closes
- [ ] Close drawer manually → tile shows updated count
- [ ] Curl `GET /api/admin/dead-letter-list` returns the expected shape
- [ ] 401 on unauthenticated, 403 on non-admin

## Phasing

Single PR (`feat/spec-76-dead-letter-drawer`). No DB migration, no env
changes. Pure additive — existing tile behavior preserved for count=0,
existing reset endpoint reused.

## Rollback

`git revert` the merge. The new `/api/admin/dead-letter-list` endpoint
becomes dead code; the tile reverts to non-clickable. No data risk.

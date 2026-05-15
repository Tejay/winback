# Spec 75 — Reasons page UX cleanup: match counts + toast-undo Remove + drop archived view

## Context

The Winback Reasons merchant page (`/reasons`) carries three problems we
walked through in the 2026-05-15 session:

1. **The "Show removed (N)" toggle exists with no clear merchant-facing
   job.** Once a merchant clicks into it, the view answers no question and
   suggests no action. New merchants don't understand soft-delete semantics
   ("I removed it, why is it still there?"). Power-merchants don't audit
   their own reason history. The toggle sits at the top of the page on
   every visit, in service of a use case (restore-from-history) that's
   structurally rare for this product.

2. **The merchant has no visibility into reason effectiveness.** They can't
   see "Native Zapier integration matched 47 customers" without leaving the
   page. The information lives in `wb_improvement_matches` but never
   surfaces in the management view, so merchants have no signal for which
   reasons are actually getting picked up by the matcher.

3. **The current Remove flow uses a two-checkbox modal.** Slow, anxious,
   and overkill for the operation. Modern app convention (Gmail, Notion)
   is optimistic-remove + toast-undo. Less friction, easier to recover
   from misclicks.

A 4th implicit concern — preserving attribution lineage when an emailed
reason is later removed — is addressed by the existing soft-delete
mechanism. That's an admin/inspector concern, not a merchant UI concern,
and is kept silently in the DB.

## Goals

1. Add a **"Matched: N customers"** badge on each active reason row
   (lifetime count; hidden when N = 0).
2. Replace the modal-confirmation Remove flow with **optimistic remove +
   10-second toast-undo**.
3. **Remove the "Show removed" toggle and archived view entirely** from
   the merchant UI.
4. Keep the underlying soft-archive DB behavior (`status='archived'`)
   intact — it's now invisible to the merchant but preserves attribution
   for admin/inspector pages and customer-support questions.

## Non-goals

- **Hard-delete cron** for 0-match archived rows. Deferred — the volume
  is tiny (low-thousands of merchants × handful of removes/year × small
  fraction with zero matches). Add it later if DB hygiene becomes a real
  concern.
- **Restore-from-history UI.** No way to recover a removed reason beyond
  the 10-second window from the merchant UI. Admin can restore via DB if
  a merchant calls support. Acceptable trade per the discussion.
- **Performance metrics** (recovery rate, conversion percentage). Lifetime
  match count is the simple v1 metric. Recovery percentage at low counts
  is noise.
- **"Last matched X ago"** staleness indicator. Defer until we see
  merchants asking for it.
- **Drop the FK cascade** on `wb_improvement_matches.improvement_id`. The
  cascade stays — we just never hard-delete from the API in v1, so it
  never fires. If a future hard-delete cron lands, that cron handles
  cascade implications then (likely by null-ing match rows' reason FK
  rather than deleting them, or by denormalising the reason title onto
  the match row first).

## Why soft-delete stays (vs hard-delete on Remove)

For the merchant, soft vs hard is invisible — the row vanishes from their
UI either way. Soft-delete exists for the **us-serving-them** layer:

| Beneficiary | Benefit |
|---|---|
| Support/admin debugging | "Why did this customer get an email mentioning Zapier?" — answerable weeks/months after the reason was removed. |
| Subscriber inspector pages | Already-built UI showing "this customer was matched with [reason title]" — works only if the reason row exists. |
| Future analytics | "Which reason categories drove the most matches over time" — needs historic rows. |
| Audit/compliance | Rare but real — producing the basis for any email we ever sent. |

The concrete failure mode of hard-deleting on Remove: `wb_improvement_matches`
has `onDelete: 'cascade'` on its `improvement_id` FK. Hard-deleting a reason
with matches would wipe the per-customer attribution rows. The inspector
page then can't answer "which reason was this customer matched against?"
That's a worse outcome than the slight DB bloat from keeping the
parent row.

## Design

### Match-count badge

Each active reason row renders a `Matched: N customers` line beside or
below the existing `Addresses: ...` line. Hidden when N = 0 (zero-count
is visual noise on freshly-added rows that haven't been processed by the
matcher yet).

UI weight: `text-xs text-slate-400` — same as the addresses line, doesn't
compete with the title.

Backend: `GET /api/improvements` adds a `matchedCount: number` field per
reason, computed via a single LEFT JOIN + COUNT on
`wb_improvement_matches`. One query, no N+1.

### Toast-undo Remove flow

1. Merchant clicks **Remove** on a row.
2. Row immediately disappears from the active list (optimistic update).
3. `POST /api/improvements/[id]/archive` fires — existing route, same
   soft-archive behavior (no API change needed).
4. A toast appears at the bottom of the page:
   `Removed "[title]". Undo (10s)`
5. **Undo click**: `POST /api/improvements/[id]/restore` fires; row
   reappears in the list. Toast dismisses immediately.
6. **No click within 10s**: toast dismisses silently. Row stays archived
   in DB. No merchant-visible recovery path beyond this point.

The two-checkbox confirmation modal is removed entirely. The 10-second
window replaces it as the safety mechanism.

### Archived view: gone

Removed from merchant UI:
- "Show removed (N)" toggle button — deleted from the header
- `showArchived` state variable — deleted
- `archived` list rendering — deleted
- `EmptyState` archived branch — deleted
- Archived `ImprovementRow` rendering (with Restore action) — deleted

API `GET /api/improvements` continues returning all rows (kept for
back-compat with any admin / test consumer). The client either filters
to `status='published'` on the response, or the server-side fetch in
`page.tsx` narrows to published. Going with the latter — cleaner.

## API contract changes

### `GET /api/improvements`

Response shape gains `matchedCount`:

```diff
 {
   improvements: [
     {
       id: string,
       title: string,
       description: string,
       dateShipped: string,
       status: 'published' | 'archived',
       addressesPattern: string | null,
       preempted: boolean,
       createdAt: string,
+      matchedCount: number,
     },
     ...
   ]
 }
```

Implementation: LEFT JOIN with a COUNT subquery on
`wb_improvement_matches`. Returns 0 when there are no match rows.

### `POST /api/improvements/[id]/archive` — unchanged

Same soft-archive behavior. Status flips to 'archived', `archived_at`
stamped. No body changes.

### `POST /api/improvements/[id]/restore` — unchanged

Used by the Undo click. Existing route works as-is.

## Code paths touched

### API

- **`app/api/improvements/route.ts`** (GET)
  Add LEFT JOIN + COUNT. Add `matchedCount` to the response shape.
  No POST changes.

### Page + client

- **`app/reasons/page.tsx`**
  - Server query narrows to `where status = 'published'` so the client
    never sees archived rows.
  - Pass `matchedCount` through in the props.

- **`app/reasons/reasons-client.tsx`**
  - **Remove**: `showArchived` state, the toggle button, `archived`
    useMemo derivation, archived-list rendering, archived
    `EmptyState` branch, `ArchiveConfirmModal` component.
  - **Add**: `matchedCount` field to the `Improvement` interface, render
    in `ImprovementRow`.
  - **Replace**: `onArchive` modal flow with optimistic remove +
    toast-undo. The toast can be inline (just a state-driven div at the
    bottom of the page) — no new shared component needed for v1.

### Optional shared component

- **`components/toast.tsx`** — if we feel like making it reusable.
  Otherwise inline in `reasons-client.tsx` is fine for v1 (it's the only
  consumer today).

### Tests

- **`src/winback/__tests__/improvements-crud.test.ts`**
  - Update the GET-returns-list assertion to verify `matchedCount` is in
    the response shape. Mock the join.
  - Existing POST/archive/restore tests unchanged.

## Edge cases

- **Multiple Removes in quick succession** — each gets its own toast,
  stacked vertically at the bottom of the screen with independent 10s
  timers. Click Undo on any one restores just that one. Simple
  array-state of "pending removes."

- **Click Undo on a toast where the row was re-archived in another tab**
  — `restore` API returns 200 (idempotent for already-published),
  client updates state, row reappears. No error.

- **Match count is very high (e.g. 500+)** — render as-is. We won't see
  this at expected volumes.

- **`matchedCount = 0` on the badge** — hide the badge entirely. Freshly-
  added rows feel clean.

- **Page reload during the 10-second toast window** — the API call has
  already fired by the time the toast appears, so the row is already
  archived in DB. Reload shows the active list without it. Toast is
  gone. As expected.

- **Inspector page for a subscriber matched against a removed reason**
  — unchanged. The `wb_improvement_matches` row + the soft-archived
  `wb_improvements` row are both still present. The inspector query
  succeeds. Attribution preserved.

- **A merchant with a hundred archived rows in DB from before this PR
  ships** — they don't see them in the UI any more. The data is silently
  preserved. No migration needed.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green
- [ ] `/reasons` renders with no "Show removed (N)" toggle
- [ ] Each row with ≥1 match shows `Matched: N customers`
- [ ] Each row with 0 matches has no matched-count badge
- [ ] Click **Remove** on a row → row disappears, toast appears
- [ ] Click **Undo** within 10s → row reappears, toast dismisses
- [ ] Wait 10s after Remove → toast dismisses, row stays gone, page
      refresh confirms
- [ ] Multiple Removes in quick succession → toasts stack, each has its
      own working Undo
- [ ] Subscriber inspector for a customer matched against a now-removed
      reason → still shows the reason title and date

## Phasing

Single PR (`feat/spec-75-reasons-cleanup`). No DB migration. No env
changes. Behavior change is purely UI + one API field. Existing archived
rows in dev/prod DB stay as they are; the new UI doesn't display them
but the inspector keeps working.

## Rollback

`git revert` the merge commit. Restores the "Show removed" toggle and
the modal confirmation flow. No data loss; the `matchedCount` field on
the API response is additive and ignored by the reverted client.

# Spec 74 — Rename "improvements" → "winback reasons" everywhere

## Context

The Winback Reasons feature was implemented under the name "improvements"
in Spec 65, but the merchant-facing surface uses both terms inconsistently:

- Page URL: `/reasons`
- Page title: "Winback reasons."
- Nav button: "Reasons"
- Body copy on the same page: "10 active **improvements**", "When should
  I add an **improvement**?"
- Reference site (`https://churntool-jxgo.vercel.app`): uses "reasons"

A merchant reading the page title (Winback reasons) then the next
paragraph (add an improvement) does mental translation work. Every
developer reading the code also does that translation — table is
`wb_improvements`, type is `Improvement`, route is `/api/improvements`,
but the product they're building is "winback reasons."

This spec finishes the rename that was started half-way through Spec 65.

### Why now

Spec 75 (planned) will redesign the Remove flow on this surface
(toast-undo + 30-day hard-delete cron, no persistent archived view).
Landing the rename before Spec 75 means the Remove redesign ships on
the cleaner naming and we never have to do this rename in the same
diff as a behavior change.

A pure rename PR is easy to review (diff is mechanical, behavior
unchanged) and easy to bisect if anything breaks. Bundling with Spec 75
loses both properties.

## Goals

1. Rename the database tables, columns, indexes, and FK constraints to
   match the merchant-facing terminology.
2. Rename TypeScript types, Drizzle schema exports, library modules,
   API routes, and event names accordingly.
3. Update all merchant-facing copy on the Winback Reasons page to use
   "reason" / "reasons" instead of "improvement" / "improvements".
4. Update the nav button text from "Reasons" → "Winback reasons".
5. Update the page heading from "Winback reasons." → "Winback reasons —
   why customers return."
6. **Behavior unchanged.** This is a rename, not a redesign.

## Non-goals

- The Remove flow redesign (toast-undo, hard-delete cron, drop archived
  view). That's Spec 75.
- Renaming `cancellationReason` on `wb_churned_subscribers`. That's a
  legitimately different concept ("why the subscriber left") from
  Winback Reason ("why they might come back"). Both columns coexist.
- Renaming the page URL `/reasons`. It's already the right name and
  changing it would break any merchant bookmarks.
- Backwards-compat for historical `wb_events` rows. Old events with
  name `improvement_published` etc. stay in the table (append-only log)
  but the admin inspector / event filters are NOT updated to recognize
  both names. Historical events under the old name may not display
  under the new admin filter labels. Acceptable trade-off: dev volume
  is tiny, prod is fresh enough that there are few historical events
  to worry about, and we'd rather have clean code than carry a dual-name
  filter list indefinitely.

## Naming choices

| Old                              | New                                  | Reasoning                                          |
|----------------------------------|--------------------------------------|----------------------------------------------------|
| Table `wb_improvements`          | `wb_winback_reasons`                 | Unambiguous against `cancellationReason` column    |
| Table `wb_improvement_matches`   | `wb_winback_reason_matches`          | Cascade rename                                     |
| Type `Improvement`               | `WinbackReason`                      | Singular cognate                                   |
| Type `ImprovementForMatcher`     | `WinbackReasonForMatcher`            | Cascade rename                                     |
| Schema export `improvements`     | `winbackReasons`                     | Drizzle camelCase                                  |
| Schema export `improvementMatches` | `winbackReasonMatches`             | Cascade rename                                     |
| Column `improvement_id` (FK)     | `winback_reason_id`                  | On `wb_winback_reason_matches`                     |
| API path `/api/improvements/*`   | `/api/winback-reasons/*`             | Matches table                                      |
| Library `lib/improvement-match`  | `lib/winback-reason-match`           | Matches type                                       |
| Event `improvement_published`    | `winback_reason_added`               | "Added" reads naturally for the merchant action    |
| Event `improvement_archived`    | `winback_reason_removed`             | Matches the "Remove" button copy                   |
| Event `improvement_restored`    | `winback_reason_restored`            | Cascade rename                                     |
| MAX_ACTIVE_IMPROVEMENTS          | `MAX_ACTIVE_REASONS`                 | Constant in `app/api/winback-reasons/route.ts`     |

### URL: page stays, API renames

- **Page URL**: `/reasons` — unchanged. The merchant sees "Reasons" in
  the URL bar; matches the conversational nav label.
- **API path**: `/api/improvements/*` → `/api/winback-reasons/*` —
  matches the table for code reviewers. Page URL and API URL don't need
  to match; they have different audiences.

## Schema migration (043_rename_improvements_to_winback_reasons.sql)

```sql
-- Rename tables (PG ALTER TABLE RENAME is atomic and fast; the table-level
-- exclusive lock during rename is taken for microseconds on tables this size).
ALTER TABLE wb_improvements         RENAME TO wb_winback_reasons;
ALTER TABLE wb_improvement_matches  RENAME TO wb_winback_reason_matches;

-- Rename the FK column on the matches table.
ALTER TABLE wb_winback_reason_matches
  RENAME COLUMN improvement_id TO winback_reason_id;

-- Rename indexes for consistency (purely cosmetic; old names still work).
ALTER INDEX IF EXISTS idx_wb_improvements_customer_status
  RENAME TO idx_wb_winback_reasons_customer_status;
ALTER INDEX IF EXISTS idx_wb_improvements_date_shipped
  RENAME TO idx_wb_winback_reasons_date_shipped;

-- Rename FK constraint for cleanliness in pg_dump output.
ALTER TABLE wb_winback_reason_matches
  RENAME CONSTRAINT wb_improvement_matches_improvement_id_wb_improvements_id_fk
  TO wb_winback_reason_matches_winback_reason_id_wb_winback_reasons_id_fk;
```

All ALTER TABLE RENAMEs are catalog-only — no data movement, no rewrite.
Total migration time: < 1 second on prod even at expected scale.

## Code paths touched

### Schema + lib

- **`lib/schema.ts`** — rename exports `improvements` → `winbackReasons`
  and `improvementMatches` → `winbackReasonMatches`. Update `pgTable()`
  names to match. Rename FK column.
- **`src/winback/lib/improvement-match.ts`** → rename file to
  `src/winback/lib/winback-reason-match.ts`. Rename internal types
  `ImprovementForMatcher` → `WinbackReasonForMatcher`. Update all
  references.

### API routes

- **`app/api/improvements/route.ts`** → move to
  `app/api/winback-reasons/route.ts`. Rename `MAX_ACTIVE_IMPROVEMENTS`
  → `MAX_ACTIVE_REASONS`. Update event name from
  `improvement_published` → `winback_reason_added`.
- **`app/api/improvements/[id]/route.ts`** → move to
  `app/api/winback-reasons/[id]/route.ts`.
- **`app/api/improvements/[id]/archive/route.ts`** → move to
  `app/api/winback-reasons/[id]/archive/route.ts`. Update event name
  `improvement_archived` → `winback_reason_removed`.
- **`app/api/improvements/[id]/restore/route.ts`** → move to
  `app/api/winback-reasons/[id]/restore/route.ts`. Update event name
  `improvement_restored` → `winback_reason_restored`.

### Page + client

- **`app/reasons/page.tsx`**
  - Heading: "Winback reasons." → "Winback reasons — why customers return."
  - Subtitle update to remove "improvements" — e.g. "Add a short, specific
    line per shipped reason. We do the matching and emailing. Up to 10
    active reasons at a time."
  - "Best practices" details copy: every "improvement" → "reason".
  - Fetch from new module name; pass `initialReasons` (renamed from
    `initialImprovements`).
- **`app/reasons/reasons-client.tsx`**
  - Rename props: `initialImprovements` → `initialReasons`.
  - Rename internal `Improvement` type → `WinbackReason`.
  - Rename state: `improvements` → `reasons`, `setImprovements` →
    `setReasons`.
  - All API fetch calls: `/api/improvements/*` → `/api/winback-reasons/*`.
  - Copy: "Active improvements" → "Active reasons", "removed
    improvements" → "removed reasons", "+ Add an improvement" →
    "+ Add a reason", "10 / MAX active improvements." → "10 / MAX active
    reasons.", "No improvements yet." → "No reasons yet.", etc.
  - The detail-page "Show removed (N)" link and EmptyState copy.

### Nav

- **`components/top-nav.tsx`** — nav button: `{ href: '/reasons', label:
  'Reasons' }` → `{ href: '/reasons', label: 'Winback reasons' }`.

### Consumers of improvements (cron + admin + tests)

- **`src/winback/lib/reengagement-cron-v2.ts`** — imports renamed
  schema (`winbackReasons`, `winbackReasonMatches`) and renamed lib
  (`winback-reason-match`). All variable names referencing
  "improvement" → "reason" or "winbackReason" as appropriate. The
  `reengagement_email_sent` event includes `improvementId` /
  `improvementTitle` properties — these are renamed too
  (`winbackReasonId`, `winbackReasonTitle`).
- **`app/api/admin/subscribers/[id]/send-reengagement-now/route.ts`** —
  same import + variable renames.
- **`app/api/cron/reengagement/route.ts`** — import path update.
- **`app/api/email/inbound/route.ts`** — variable names referencing
  improvement IDs.
- **`app/api/test/winback-flow/route.ts`** — full rename. Update event
  filtering.
- **`app/admin/subscribers/[id]/inspector-client.tsx`** — event filter
  display + admin inspector strings. Switch to new event names only.
  (Old `improvement_*` events in the historical log won't match the new
  filter labels — acceptable per Non-goals.)
- **`app/dashboard/dashboard-client.tsx`** — any references in the
  re-engagement timeline / drawer.

### Tests

- **`src/winback/__tests__/improvements-crud.test.ts`** → rename file to
  `winback-reasons-crud.test.ts`. Update imports + assertions.
- **`src/winback/__tests__/improvement-match.test.ts`** → rename file to
  `winback-reason-match.test.ts`. Update imports + types.
- **`src/winback/__tests__/admin-subscriber-lifecycle.test.ts`** — update
  references to renamed schema / lib.
- **`src/winback/__tests__/classifier.test.ts`** — any reference to the
  schema export.
- **`src/winback/__tests__/funnel-spec-72.test.ts`** — uses
  `improvements` and `improvementMatches` in mock setup.
- **`src/winback/__tests__/classifier-tick.test.ts`** — same.

### Scripts

- **`scripts/seed-spec65-v2-test.ts`** — full rename. (Optional — script
  is dev tooling; could leave with old names if cleanup not in scope.
  Decision: rename for consistency.)
- **`scripts/seed-pagination-test.ts`** — uses `improvements`. Rename
  references.
- **`scripts/funnel-live-test-spec72.ts`** — uses `improvements`. Rename
  references.

### Cron schedule labels

- **`lib/cron-schedules.ts`** — any human-readable label that mentions
  "improvement" → "reason".

## Backwards compatibility

### Historical events

Skipped — see Non-goals. Old event names stay in the table but admin
filters don't recognize them.

### URL routes

The old `/api/improvements/*` route paths are dropped. No external
consumers — the only callers are the project's own client code, all
updated in the same PR.

## Edge cases

- **Concurrent in-flight requests during deploy** — there's a window
  between "code deployed" and "migration applied" (or vice versa)
  where the running instance might reference the wrong table name.
  Handled by applying the migration BEFORE merging the code PR
  (same flow as Spec 72 migration 042).
- **Foreign key cascade behavior unchanged** — the rename keeps the
  ON DELETE CASCADE on `winback_reason_id` so deleting a winback reason
  still nukes its matches rows.
- **Old event names in admin display** — display layer falls back to
  showing both old and new event-name variants under a single label.
- **External integrations** — none. The `/api/improvements/*` paths are
  internal-only.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green (file renames + import path renames)
- [ ] Run migration 043 on dev → confirm tables/columns/indexes/FK
      constraints renamed; query `SELECT count(*) FROM wb_winback_reasons`
      returns the row count that was previously in `wb_improvements`.
- [ ] Dev server: `/reasons` loads, nav shows "Winback reasons", page
      heading shows "Winback reasons — why customers return.", body
      copy reads "reasons" not "improvements", Add / Edit / Remove
      flows still work.
- [ ] Add a reason → `winback_reason_added` event emits.
- [ ] Archive a reason → `winback_reason_removed` event emits.
- [ ] Restore a reason → `winback_reason_restored` event emits.
- [ ] V2 re-engagement cron still works (run a test subscriber through
      to confirm matching + sending still function end-to-end).
- [ ] Apply migration 043 to prod before merging the code PR.

## Phasing

1. Docs-only commit on `main` — this spec.
2. Human approval.
3. Branch `feat/spec-74-rename-reasons`.
4. Code + tests + migration in one PR.
5. Apply migration 043 to dev → run vitest + manual click-through.
6. Apply migration 043 to prod (before merging code PR).
7. Merge code PR → Vercel deploys.
8. Optional: drop the seeded test rows from dev after click-through.

## Rollback

If something breaks after merge:
- Code revert: `git revert` the merge commit. Vercel redeploys old code.
- Schema rollback: opposite migration — rename tables/columns/FKs back.
  PG ALTER TABLE RENAME is symmetric. Data is unchanged so no data-loss
  risk.

The window of risk is the few minutes between deploy and verification.
Mitigation: apply migration to prod first, then deploy code, and verify
admin inspector + a reason CRUD round-trip immediately.

# Spec 69 — Cron-health widget + per-customer subscriber list

## Context

From the 2026-05-14 support-readiness audit, category H (System
troubleshooting):

- **#24 (P2)** — "The daily cron didn't run today." Currently zero
  cron visibility inside our admin. The only way to check today is
  Vercel's own Crons dashboard, which support hires won't have access
  to.
- **#26 (P1)** — "Subscribers list for one customer." Customer detail
  shows last 20 emails but no full subscriber list scoped to that
  merchant. Cross-customer search exists at `/admin/subscribers`
  but can't be pre-filtered to one customer.

(Item #25 "manually trigger a cron" — dropped. Vercel's Cron dashboard
already does this with one click; building it in-app is duplicate
plumbing pre-launch.)

## Goals

1. **Cron health table** on `/admin` Overview, one row per cron:
   - Name (slug as configured in `vercel.json`)
   - Schedule (human-readable, e.g. "daily 09:00 UTC")
   - Last run timestamp + status badge (ok / failed / stale)
   - Last run duration (ms)
   - Stale rule: no run within (schedule expected interval × 1.5)
2. **`cron_run` event** emitted by every cron route via a thin
   wrapper helper. Carries `{ name, durationMs, ok, errorMessage? }`
   in `properties`. Drives the widget. Existing per-cron events
   (`billing_nudge_sent`, etc.) stay untouched.
3. **"View subscribers (N)"** link on customer detail page →
   navigates to `/admin/subscribers?customerId=<id>` which renders
   the existing subscribers search pre-filtered to that customer.
4. **`/admin/subscribers` accepts `customerId` query param** to
   filter the search. Existing email-based search still works.

## Non-goals

- Manual cron trigger from in-app (Vercel dashboard already covers).
- Alerting / pager when a cron goes stale. (Email/Slack alert is a
  follow-up; v1 is "support can spot it on Overview".)
- Per-cron drill-down page with run history. Last run + status is
  enough for v1.
- Rewriting the existing cron event schema for the 6 crons.

## Schema

**No migration.** New event name `cron_run` lands in the existing
`wb_events` table.

## Code paths touched

### Cron wrapper helper

**New: `src/winback/lib/cron-wrap.ts`** — small helper to standardize
the auth check + emit `cron_run` event:

```ts
export async function withCron<T>(
  name: string,
  req: Request,
  fn: () => Promise<T>,
): Promise<Response> {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const start = Date.now()
  try {
    const result = await fn()
    await logEvent({
      name: 'cron_run',
      properties: { name, ok: true, durationMs: Date.now() - start },
    })
    return NextResponse.json({ ok: true, ...(result ?? {}) })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    await logEvent({
      name: 'cron_run',
      properties: { name, ok: false, durationMs: Date.now() - start, errorMessage },
    })
    throw err
  }
}
```

Each cron route then becomes:

```ts
export const GET = (req: NextRequest) =>
  withCron('reengagement', req, () => runReengagementCronV2())
```

Six cron routes updated:
- `/api/cron/reengagement`
- `/api/cron/onboarding-followup`
- `/api/cron/dunning-followup`
- `/api/cron/cumulative-revenue`
- `/api/cron/billing-nudge`
- `/api/cron/drain-paused-queue`

### Cron-health query

**New helper in `lib/admin/cron-queries.ts`** — `getCronHealth()`:

```ts
SELECT DISTINCT ON (properties->>'name')
  properties->>'name' AS name,
  properties->>'ok'   AS ok,
  (properties->>'durationMs')::int AS duration_ms,
  properties->>'errorMessage'      AS error_message,
  created_at
FROM wb_events
WHERE name = 'cron_run'
ORDER BY properties->>'name', created_at DESC;
```

Returns rows merged with the static `CRON_SCHEDULES` config so unknown
crons or never-run crons appear too (status: never-run).

### Static schedule config

**New: `lib/cron-schedules.ts`** — single source of truth for the
human-readable schedule labels + expected-interval-in-seconds
(derived from `vercel.json`). Used by the widget for the stale
heuristic.

```ts
export const CRON_SCHEDULES = [
  { name: 'reengagement',       cron: '0 9 * * *',  label: 'Daily 09:00 UTC',   maxIntervalSecs: 86400 * 1.5 },
  { name: 'onboarding-followup',cron: '30 9 * * *', label: 'Daily 09:30 UTC',   maxIntervalSecs: 86400 * 1.5 },
  { name: 'dunning-followup',   cron: '0 8 * * *',  label: 'Daily 08:00 UTC',   maxIntervalSecs: 86400 * 1.5 },
  { name: 'cumulative-revenue', cron: '0 3 * * *',  label: 'Daily 03:00 UTC',   maxIntervalSecs: 86400 * 1.5 },
  { name: 'billing-nudge',      cron: '0 10 * * *', label: 'Daily 10:00 UTC',   maxIntervalSecs: 86400 * 1.5 },
  { name: 'drain-paused-queue', cron: '*/5 * * * *', label: 'Every 5 minutes',  maxIntervalSecs: 60 * 15 },
]
```

(Mirrors `vercel.json` — could be derived programmatically, but a
hand-maintained const is clearer for the 6 known crons. If we add a
7th, both files get edited together.)

### UI

**`app/admin/overview-client.tsx`** — render a new "Cron health"
section below the existing metrics. One row per cron with the badge,
last-run timestamp, duration.

**`app/api/admin/overview/route.ts`** — extend the payload with
`cronHealth: CronHealthRow[]`.

### Customer detail page deep-link

**`app/admin/customers/[id]/customer-detail-client.tsx`** — add a
"View N subscribers" link near the identity header, linking to
`/admin/subscribers?customerId=<id>`.

**`app/api/admin/customers/[id]/route.ts`** — extend payload with
`subscriberCount: number` so the link can show the count.

### Subscriber search customerId filter

**`app/api/admin/subscribers/route.ts`** — accept `customerId` query
param. When present, return all subscribers for that customer
(ignoring email search). When absent, current behaviour unchanged.

**`app/admin/subscribers/subscribers-search-client.tsx`** — read
`?customerId=<id>` from URL on mount. If present, fetch the
customer-scoped list and show a "Filtered to {productName}" pill at
the top with an "× clear filter" button that strips the query param.

## Edge cases

- **Cron has literally never run** (e.g. brand-new): widget shows
  "never run" status grey. Stale heuristic doesn't apply.
- **`cron_run` event helper throws while logging the event** (DB
  unreachable): the cron handler still re-raises so Vercel knows it
  failed; the visibility blip is acceptable.
- **Two cron runs back-to-back**: SQL `DISTINCT ON name ORDER BY
  created_at DESC` returns only the latest. Older run is still in
  `wb_events` for forensic queries.
- **Subscriber-search URL with both `email` and `customerId`**:
  `customerId` wins (it's the deeper filter).
- **Customer with 0 subscribers**: "View 0 subscribers" link goes to
  an empty filtered page. Don't suppress the link; the empty state is
  itself informative.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — add tests:
  1. `withCron` emits `cron_run` with `ok: true` on success
  2. `withCron` emits `cron_run` with `ok: false, errorMessage` on
     thrown error AND re-raises
  3. `withCron` returns 401 when `CRON_SECRET` header missing
  4. `getCronHealth()` merges DB rows with `CRON_SCHEDULES` and marks
     never-run crons appropriately
  5. `/api/admin/subscribers?customerId=<id>` returns rows for that
     customer only
- [ ] Manual smoke on dev:
  - Trigger any cron via curl with `CRON_SECRET`. Open `/admin` →
    confirm the row updates within 1s
  - Click "View N subscribers" on customer detail → arrive at
    pre-filtered subscriber search → click "× clear filter" → list
    becomes empty (full cross-customer search)
- [ ] No prod migration.

## Phasing

One PR.

## Rollback

Each of the 4 surfaces (wrapper, widget, deep-link, customerId param)
is additive. Reverting removes UI; cron behaviour is otherwise
unchanged. Event-log rows already written stay valid.

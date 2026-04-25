# Spec 25 — Operational Admin Dashboard (Phase 1)

**Phase:** Pre-launch / Week 1 of live customers
**Depends on:** Spec 22a (AI state model), Spec 17 (`wb_events`), migration 017 (handoff judgment fields)

---

## Summary

Internal `/admin` area for Winback's own team — separate from `/dashboard` (which is per-customer self-serve). Phase 1 scope is the minimum surface needed to **(a)** triage subscriber complaints within five minutes, **(b)** support Winback customers when their integration breaks, and **(c)** see at a glance whether the platform is on fire.

Phases 2 (AI quality + billing) and 3 (impersonation, audit log UI, replay) are out of scope here and tracked as future specs.

---

## Context

Today there is **no admin surface**. Two operational gaps will hit on day one of real traffic:

1. **Subscriber complaints have no triage path.** Every existing query is scoped to a single `customer_id` (`WHERE customers.user_id = session.user.id`). When `pat@example.com` emails support saying "why am I getting these emails?", we cannot find Pat's row across all customers without raw SQL access.

2. **Customer support has no diagnostic view.** When a Winback customer says "my Stripe integration broke", we have no UI to inspect their webhook history, OAuth state, or recent error events.

Data substrate is already in place: `wb_events` writes 24+ event types indexed on `(name, created_at)` and `(customer_id, created_at)`; `wb_billing_runs` tracks invoice state; `customer.paused_at` is a working kill switch consulted by `scheduleExitEmail`. The only missing primitives are an **admin auth gate** and a **cross-customer subscriber lookup**.

Phase 1 ships four pages, one schema migration, one new auth helper, and one new query primitive. ~10 files, behind a feature-flagged route.

---

## Schema (migration 018)

```sql
-- migration 018_admin_role.sql
ALTER TABLE wb_users
  ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Seed the founder so the dev harness email check can be retired.
UPDATE wb_users SET is_admin = TRUE WHERE email = 'tejaasvi@gmail.com';

-- Lookup index for the cross-customer subscriber search (Phase 1.3).
-- Email is already searchable via ILIKE but a btree on lower(email) makes
-- exact-match the dominant case (the support flow) sub-millisecond.
CREATE INDEX IF NOT EXISTS idx_churned_subscribers_email_ci
  ON wb_churned_subscribers (LOWER(email))
  WHERE email IS NOT NULL;
```

`is_admin` on `wb_users` (not on `wb_customers`) so it survives Stripe disconnection and isn't confused with founder identity. Future admins added via SQL `UPDATE` until we build a manage-admins UI (Phase 3).

---

## Auth & data-access pattern

### Two database connections (the safety guardrail)

```ts
// lib/db.ts (modified)
export const db          = drizzle(neon(process.env.DATABASE_URL!))            // existing — read+write, used by app + admin mutations
export const dbReadOnly  = drizzle(neon(process.env.DATABASE_URL_READONLY!))   // new — Postgres role with SELECT only
```

`DATABASE_URL_READONLY` points at a Neon role with only `SELECT` granted on `wb_*` tables. Admin **read** queries use `dbReadOnly`. Admin **mutation** endpoints (DNC, GDPR delete, pause-customer, force-OAuth-reset, resolve-handoff) use the existing `db` and are **explicitly named** so they require a code-review beat to add.

Rationale (see [#why-read-only](#design-decisions)): a missing `WHERE` in admin code corrupts data across every customer at once because admin queries are unscoped by definition. The DB enforces what code review might miss.

Statement timeout on the read-only connection: `SET statement_timeout = '5s'` per session. A runaway aggregation gets killed before it starves the prod connection pool.

### `requireAdmin()` helper

```ts
// lib/auth.ts (extended)
export async function requireAdmin(): Promise<
  | { userId: string }
  | { error: string; status: 401 | 403 }
> {
  const session = await auth()
  if (!session?.user?.id) return { error: 'Not signed in', status: 401 }
  const [user] = await dbReadOnly
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1)
  if (!user?.isAdmin) return { error: 'Admin only', status: 403 }
  return { userId: session.user.id }
}
```

Used by `/admin/layout.tsx` (server component, redirects on failure) and every `/api/admin/*` route handler. Replaces the hard-coded email check in `/app/test/winback-flow/page.tsx`.

### New shared utilities

- `lib/admin/subscriber-search.ts` — `findSubscribersByEmail(email: string, opts?: { limit?: number })`. Hits the new `idx_churned_subscribers_email_ci` index. Returns rows with their owning customer joined. Wrapped to emit `logEvent({ name: 'admin_subscriber_lookup', userId, properties: { email, resultCount } })` so every support touch is auditable.
- `lib/admin/rollups.ts` — small cacheable counters built on `wb_events` `groupBy` queries. All return arrays sized for sparkline rendering (7 buckets).
- `lib/dsr.ts` — extracted from `scripts/dsr.ts` so the admin UI and the CLI share one implementation. CLI becomes a thin wrapper.

---

## Surfaces

### 1.1 `/admin` — Overview

**Route:** `app/admin/page.tsx` (server component)
**API:** `app/api/admin/overview/route.ts`

Five top counters, each with a 7-day sparkline from `wb_events`:

| Counter | Source query (against `dbReadOnly`) |
|---|---|
| Classifications today | `count(*)` from `wb_events` where `name = 'email_sent'` AND `created_at >= today` (proxy — every send corresponds to one classification) |
| Emails sent today | same as above |
| Replies today | `count(*) where name = 'email_replied'` |
| Recoveries today | `count(*) where name = 'subscriber_recovered'`, group by `properties->>'attributionType'` |
| Errors today | `count(*) where name in ('oauth_error','billing_invoice_failed') OR properties ? 'error'` |

Each tile renders today's number + a 7-bucket sparkline (`date_trunc('day', created_at)` group-by, ordered ascending). All five queries hit the `(name, created_at)` index. Should respond in < 100ms even at 100k events/day.

**Platform totals** (one row): active customers (count `wb_customers` where `stripe_access_token IS NOT NULL`), trial vs paid split, total subscribers ever processed.

**Red lights** block: any of the five counters where `today_value > 3 × median(last_7_days)`. Renders only if any flag fires. Links to `/admin/events` filtered by event name.

Polls `/api/admin/overview` every 30s client-side.

### 1.2 `/admin/customers` and `/admin/customers/[id]`

**Routes:** `app/admin/customers/page.tsx`, `app/admin/customers/[id]/page.tsx`
**APIs:** `app/api/admin/customers/route.ts`, `app/api/admin/customers/[id]/route.ts`, `app/api/admin/actions/{pause-customer,force-oauth-reset,resolve-handoff}/route.ts`

**List view** — search input (ILIKE on email, founder_name, stripe_account_id) + sortable table. Columns: email, plan (trial/paid derived from `customer.plan`), Stripe state (`✓ conn` if `stripe_access_token` present, `✗ expired` otherwise), `#subs` (count of `wb_churned_subscribers`), `#recoveries` (count of `wb_recoveries`), last-activity timestamp (latest `wb_events.created_at` where `customer_id = X`). Default sort: last activity desc. Page size 50.

**Detail view** — single page, top to bottom:

1. **Identity** — `founder_name`, `product_name`, `notification_email`, plan, `paused_at` state
2. **Stripe health** — `stripe_account_id`, last `customer.subscription.deleted` webhook (latest `wb_events` row where `customer_id = X` and `name = 'webhook_received'`* or fall back to most recent `subscriber_recovered` / `email_sent`), recent `oauth_error` event count (7d)
3. **Recent emails (last 20)** — join `wb_emails_sent` ⨝ `wb_churned_subscribers` for this customer's emails, descending `sent_at`
4. **Recent events (last 50)** — `wb_events` filtered by `customer_id`, descending `created_at`. Each row links to `/admin/events?event_id=…` for the full JSON
5. **Billing snapshot** — most recent `wb_billing_runs` row, count of unbilled `wb_recoveries` with `attribution_type = 'strong'`, `customer.stripe_platform_customer_id` presence
6. **Emergency actions** — three buttons:
   - `Pause all sending` → `POST /api/admin/actions/pause-customer` (toggles `paused_at`)
   - `Force OAuth reset` → clears `stripe_access_token` + `stripe_account_id`, customer redirected to `/onboarding/stripe` on next session
   - `Resolve open handoffs` → bulk `UPDATE wb_churned_subscribers SET founder_handoff_resolved_at = now() WHERE customer_id = X AND founder_handoff_resolved_at IS NULL`

Each action emits `logEvent({ name: 'admin_action', userId: adminUserId, customerId, properties: { action, before, after } })` — Phase 3 will add an audit-log UI on top of these.

\* If `webhook_received` isn't already an event, we either add it here or use a shadow query against `wb_emails_sent` to infer last activity. Decide during implementation; not a blocker.

### 1.3 `/admin/subscribers` — cross-customer lookup

**Route:** `app/admin/subscribers/page.tsx`
**API:** `app/api/admin/subscribers/search/route.ts`

The complaint-triage page. Single email input → calls `findSubscribersByEmail(email)` → table of all matching `wb_churned_subscribers` across every customer.

Columns: customer name (linked to `/admin/customers/[id]`), subscriber name, status, AI state (use existing `lib/ai-state.ts` helper), last email sent (date + type), DNC (✓/✗).

Row click opens a detail drawer that **mirrors the existing `/dashboard` drawer** (`app/dashboard/dashboard-client.tsx` lines 442–700): identity grid, cancellation reason block, **AI judgment block from PR #26**, full email thread, status banners. Reuse the component; do not duplicate.

Row actions in the drawer footer:
- `Mark DNC` → `POST /api/admin/actions/unsubscribe` (sets `do_not_contact = true`, idempotent)
- `Export JSON` → calls `lib/dsr.ts` `export(subscriberId)`, downloads as file
- `Delete (GDPR)` → calls `lib/dsr.ts` `delete(subscriberId)`, requires typed confirmation in a modal (matches CLI behavior). Cascades through existing FKs.
- `View thread` → already shown in drawer

Empty state: zero rows — show the searched email + "No churned subscribers found across any Winback customer." Useful confirmation when the complainer wasn't actually our doing.

### 1.4 `/admin/events`

**Route:** `app/admin/events/page.tsx`
**API:** `app/api/admin/events/route.ts`

Filterable stream from `wb_events` via `dbReadOnly`. URL-driven state so links are shareable (`/admin/events?customerId=X&name=oauth_error&since=24h`).

Filters:
- **Event name** — `<select>` populated from a hardcoded list of the 24 known event names + an "All" option
- **Customer** — text input matching `customer_id` UUID, or pasteable from the customers page
- **Date range** — `last_1h` / `last_24h` / `last_7d` / `last_30d` (radio)
- **Properties search** — text input that does `properties::text ILIKE '%term%'` (last-resort, slow on big tables — flag in UI as "slow")

Results: 200 most recent rows by default, paginated with cursor (`created_at` + `id`). Each row: relative time, event name (color-coded by category — error = red, billing = green, send = blue, etc.), customer email (joined), collapsed properties JSON. Click row to expand full JSON.

Always filters with at least one of `(name, ...)` or `(customer_id, ...)` to hit an existing index. If a user clears all filters, default to "last 24h, all events" so the query stays bounded.

---

## File manifest (Phase 1)

| Path | Status | Purpose |
|---|---|---|
| `src/winback/migrations/018_admin_role.sql` | NEW | `is_admin` column + email index |
| `lib/schema.ts` | EDIT | add `isAdmin` to `users` table |
| `lib/db.ts` | EDIT | export new `dbReadOnly` instance |
| `lib/auth.ts` | EDIT | export `requireAdmin()` |
| `lib/admin/subscriber-search.ts` | NEW | `findSubscribersByEmail` |
| `lib/admin/rollups.ts` | NEW | overview aggregation queries |
| `lib/dsr.ts` | NEW | extracted from `scripts/dsr.ts`, used by admin + CLI |
| `scripts/dsr.ts` | EDIT | become a thin wrapper around `lib/dsr.ts` |
| `app/admin/layout.tsx` | NEW | gate + sidebar shell |
| `app/admin/page.tsx` | NEW | overview |
| `app/admin/customers/page.tsx` | NEW | list |
| `app/admin/customers/[id]/page.tsx` | NEW | detail |
| `app/admin/subscribers/page.tsx` | NEW | cross-customer search |
| `app/admin/events/page.tsx` | NEW | event log viewer |
| `app/api/admin/overview/route.ts` | NEW | counters |
| `app/api/admin/customers/route.ts` | NEW | list endpoint |
| `app/api/admin/customers/[id]/route.ts` | NEW | detail endpoint |
| `app/api/admin/subscribers/search/route.ts` | NEW | cross-customer search endpoint |
| `app/api/admin/events/route.ts` | NEW | filtered event stream |
| `app/api/admin/actions/pause-customer/route.ts` | NEW | mutation |
| `app/api/admin/actions/force-oauth-reset/route.ts` | NEW | mutation |
| `app/api/admin/actions/resolve-handoff/route.ts` | NEW | mutation |
| `app/api/admin/actions/unsubscribe/route.ts` | NEW | mutation |
| `app/api/admin/actions/dsr-delete/route.ts` | NEW | mutation |
| `app/test/winback-flow/page.tsx` | EDIT | replace email check with `requireAdmin()` |
| `src/winback/__tests__/admin-*.test.ts` | NEW (5+ files) | one per route + helper |

---

## Environment variables

Add to `.env.local` and Vercel envs (production + preview):

```
DATABASE_URL_READONLY=postgresql://winback_readonly:…@…/winback?sslmode=require
```

Provisioned by running, on the Neon SQL editor against the prod DB:

```sql
CREATE ROLE winback_readonly WITH LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE winback TO winback_readonly;
GRANT USAGE ON SCHEMA public TO winback_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO winback_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO winback_readonly;
ALTER ROLE winback_readonly SET statement_timeout = '5s';
```

Per CLAUDE.md, set the env var via `printf` (no trailing newline) and add for **both** production and preview.

---

## Test requirements

Per CLAUDE.md: every lib module gets unit tests. Mock pattern from existing `email-handoff.test.ts`.

**Required tests:**

- `requireAdmin` — returns 401 unsigned, 403 non-admin, `{userId}` for admin
- `findSubscribersByEmail` — returns matching rows across customers, normalises case, respects `limit`, emits the audit event
- `lib/dsr.ts` — export shape, delete cascades, idempotency
- Each admin API route — auth gate fires, happy path returns expected shape, mutation routes log `admin_action` event
- The cross-customer search route specifically: must NOT leak customer_id of customers the requesting admin shouldn't see (currently no per-admin scoping, but tested so future scoping is safe)

**Out-of-scope for unit tests** (cover via dev-server end-to-end):
- Sparkline rendering
- Drawer reuse from `/dashboard`

---

## Verification

1. `npx tsc --noEmit` — clean
2. `npx vitest run` — all new tests green; existing 253 tests still passing
3. Migration 018 applied to Neon; `SELECT is_admin FROM wb_users WHERE email='tejaasvi@gmail.com'` returns `true`
4. New Postgres role created and granted; `psql $DATABASE_URL_READONLY -c "INSERT INTO wb_users …"` returns `permission denied`
5. End-to-end on `npm run dev` after seeding via `/test/winback-flow`:
   - **Subscriber complaint flow**: paste a seeded subscriber's email into `/admin/subscribers`, verify the row appears with the correct customer, click `Mark DNC`, verify `do_not_contact = true` in DB, verify `scheduleExitEmail` now skips them on next reply.
   - **Customer support flow**: open `/admin/customers/[id]` for a seeded customer, verify Stripe health renders, click `Force OAuth reset`, verify `stripe_access_token` is cleared and the customer is redirected to `/onboarding/stripe` on their next page load.
   - **Platform health**: open `/admin`, verify all five counters render with sparklines, verify no red-light fires under normal traffic.
   - **Event search**: paste a seeded `customer_id` into `/admin/events?customerId=…`, verify filtered stream returns this customer's events ordered by recency.
6. Read-only enforcement check: in a dev environment, deliberately swap a write call (e.g., the `Mark DNC` handler) to use `dbReadOnly` instead of `db`. The DB must reject with `permission denied for table wb_churned_subscribers`. Restore after.

---

## Design decisions

### Why `is_admin` on `wb_users` (not `wb_customers`)

Admins are people, not businesses. A future Winback employee won't have a Stripe-connected `wb_customers` row but will need admin access. Putting it on `wb_users` keeps the concept clean and survives any tenant-side disconnection.

### Why a separate read-only DB role is the most important guardrail

Performance guardrails (timeouts, indexes, `LIMIT`) protect against slow queries. They don't protect against a missing `WHERE` clause that runs `UPDATE wb_customers SET paused_at = now()` against every row in one transaction. The customer-facing app is naturally scoped — every query starts with `WHERE customer_id = session.customer.id` because **the auth gates it**. Admin code has no such scoping by definition; it's allowed to touch every row across every customer. A read-only role makes those mistakes a Postgres `permission denied` instead of silent corruption. The few endpoints that genuinely need to mutate are explicitly named (`actions/`) so each one gets a code-review beat.

### Why we reuse the `/dashboard` drawer instead of building a new one

The drawer in `app/dashboard/dashboard-client.tsx` already renders status badges, identity grid, cancellation reason, AI judgment panel (PR #26), email history, and handoff banners. Duplicating it would silently drift; reusing it means PR #26's AI judgment surface gets the cross-customer view for free.

### Why no impersonation / "view as customer" mode in Phase 1

Powerful for support but unsafe without separate review (session forgery, audit gaps, accidental founder-side mutations). Tracked as Phase 3.

---

## Out of scope (future phases)

### Phase 2 — AI quality + billing + observability gaps + UX refinements

The original Phase 2 scope (AI quality + billing) plus a set of follow-ups identified during Phase 1 build / dogfooding:

**New surfaces:**
- `/admin/ai-quality` — handoff volume trend (30d), recovery-likelihood histogram, tier distribution, last 50 hand-off reasonings for audit, last 50 `subscriber_auto_lost` events
- `/admin/billing` — latest run status breakdown, failed-invoice retry, outstanding obligations report, MRR-recovered trend

**Observability gaps (close the error-event taxonomy):**

The `/admin` overview's *Errors* counter currently sums `oauth_error` + `billing_invoice_failed` + `reactivate_failed` — the only error events instrumented as first-class `wb_events` rows today. Other failure paths throw exceptions but don't emit events, so they go invisible on the overview. Each one is ~6 lines in the relevant catch block:

- **Resend email send failures** — `src/winback/lib/email.ts` throws on Resend errors. Add `logEvent({ name: 'email_send_failed', customerId, properties: { subscriberId, errorMessage } })` before re-throwing. Without this, a flaky transactional-email provider goes unnoticed.
- **Anthropic classifier failures** — `src/winback/lib/classifier.ts` throws on parse / API failure. Add `logEvent({ name: 'classifier_failed', ... })`. Catches model outages and JSON-parse regressions.
- **Stripe webhook signature failures** — `app/api/stripe/webhook/route.ts` returns 400 silently. Add `logEvent({ name: 'webhook_signature_invalid', properties: { sourceIp } })`. Catches webhook secret rotations and impersonation attempts.
- **DB connection / timeout errors** — currently uncaught at top level. Wrap top-level handlers and emit `db_error` events.

Once these four are wired, the overview's Errors counter reflects actual platform health (not just "the three things I happened to instrument first") — and the spike-detection logic catches more failure modes.

**Overview refinements (data-driven):**
- **Replies → handoffs metric swap.** Reply count is a weak signal (doesn't distinguish happy from angry). Once enough volume exists, swap the Replies counter for "Hand-offs triggered today" — directly maps to AI-quality, more actionable on a daily glance.
- **Add MRR-recovered dollar figure.** Recoveries are counted by row but you have to do mental math to translate to revenue. Add a sixth counter: `$X recovered today` with a 7-day sparkline. The single most important business metric should be visible at a glance.
- **Split errors counter.** OAuth, Billing, Reactivate (and the new ones above) lumped together makes triage harder. At scale, render as three side-by-side micro-counters with their own sparklines.

**Events page refinements:**
- **"Customer found, but no events in this date range" hint.** When a valid customer email/UUID is searched and the date filter returns zero, the API should also return `customerEventsOutsideRange: <count>` so the UI can render *"This customer has 39 events outside the chosen range — extend the range to see them"* instead of a silent zero. Avoids the "looks broken" failure mode I hit when testing.

**Subscribers page refinements:**
- **Bulk DNC.** Multi-select rows + one button. When a complaint cites multiple customers ("I'm getting emails from three different products"), one click closes them all.

### Phase 3 — Operations & SOC 2 prep

- Admin audit-log UI (filtered view of `admin_action` events, retention guarantees, SOC 2 trail)
- Customer impersonation ("view `/dashboard` as if I were customer X") — needs separate security review
- Webhook replay (re-fire a Stripe webhook from logs)
- Real-time WebSocket / Server-Sent Events on overview
- Email template editor (per-customer tone customisation)
- Manage-admins UI (replace the SQL `UPDATE` for adding new admins)

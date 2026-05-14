# Spec 68 — Admin impersonation ("log in as customer")

## Context

From the 2026-05-14 support-readiness audit, item #20 (P1): when a
merchant says "I can't see X, can you check?", support today either
asks for a screenshot, asks them to send their password (unacceptable),
or queries the DB directly. None of those work for UI-rendering bugs.

This spec adds a single short-lived "Impersonate" capability that lets
an admin browse the app as a specific merchant, then click "Stop" to
revert.

## Goals

- "Impersonate" button on `/admin/customers/[id]` Emergency Actions
  section. Single click → session swap → redirect to `/dashboard` (the
  merchant's home). Confirm dialog asks the admin to type the merchant
  email as a guard against fat-finger.
- Top-bar banner on every merchant-side page (dashboard, settings,
  reasons) while impersonation is active: red bar with founder email,
  admin email, time remaining, and a "Stop impersonating" button.
- "Stop impersonating" reverts to the admin session instantly, no
  re-login needed. Redirects to wherever they came from (the original
  customer detail page).
- Audit log captures both `impersonation_start` and `impersonation_stop`
  events with `{ adminId, adminEmail, targetUserId, targetEmail }` and
  the time elapsed (on stop).
- 30-minute hard cap. If the admin walks away, the cookie auto-expires
  and they're bounced to the login page. They can re-impersonate from
  fresh.

## Non-goals

- Read-only impersonation mode (full access; see Security model below).
- Multi-user concurrent impersonation in the same browser. One at a
  time; admin must Stop before starting a new one.
- Route allowlist / denylist (e.g. "admin can impersonate but not
  trigger the billing portal"). Bigger design conversation; defer.
- Pre-impersonation merchant notification email. Defer until at least
  one paying merchant exists.
- DB-tracked impersonation sessions / kill switch. JWT TTL is the
  enforcement mechanism; rotating NEXTAUTH_SECRET is the emergency
  exit. If we ever need force-revoke, separate spec.
- Impersonating an admin (no one impersonates an admin from inside
  this admin tool — that would let an admin escalate to "system" or
  bypass audit).

## Security model

Full impersonation. Once you're in, you can do anything the merchant
can do — including settings changes, billing portal access, archiving
improvements. Every mutating request looks like a normal merchant
request to the server, so existing audit trails apply as written.

The impersonation `start` and `stop` events bookend the session in
`wb_events` so we can later attribute any specific mutation to the
admin who was inside the cookie at that time. If/when an action goes
wrong, we use the event log to trace back: "founder@acme.com modified
their plan at 14:32 — but `impersonation_start` for tejay@... was logged
at 14:30 and `impersonation_stop` at 14:35; therefore it was the admin,
not the merchant."

Admins cannot impersonate other admins. The start endpoint rejects
when the target user has `isAdmin = true`. This prevents privilege
escalation and accidental admin-on-admin confusion.

## Mechanism (the cookie shuffle)

NextAuth v5 with JWT strategy. Today the session JWT is
`{ id: userId }`. We extend it:

```ts
{
  id: <targetUserId>,            // who the server sees as logged in
  impersonator: {                // present iff active impersonation
    adminId: <realAdminId>,
    adminEmail: <real admin's email>,
    startedAt: <ISO timestamp>,
    expiresAt: <ISO timestamp>,  // startedAt + 30 min
  } | undefined
}
```

**Start** — `POST /api/admin/actions/impersonate { targetUserId,
confirmEmail }`. Server:
1. `requireAdmin()` gate.
2. Validate `confirmEmail` matches target user's email exactly.
3. Reject if target is an admin OR if the current JWT already has
   `impersonator` (must stop first).
4. Mint a new JWT with `id = targetUserId` and `impersonator = {...}`.
5. Set the same `next-auth.session-token` cookie name to the new JWT,
   with `expires = now + 30min`. NextAuth's `auth()` reads the cookie
   next request and returns the founder's identity.
6. Log `impersonation_start` event.
7. Respond with `{ ok: true, redirect: '/dashboard' }`. Client
   follows.

**Stop** — `POST /api/admin/actions/stop-impersonating`. Server:
1. Read current JWT. Reject if no `impersonator` field present (you're
   not impersonating, nothing to stop).
2. Mint a new JWT with `id = impersonator.adminId`, no
   `impersonator` field, normal expiry.
3. Overwrite the cookie.
4. Log `impersonation_stop` event with elapsed seconds.
5. Respond with `{ ok: true, redirect: '/admin/customers/<targetCustomerId>' }`.

Both endpoints use HMAC-signing via NextAuth's existing `encode`
helper from `next-auth/jwt`, so we don't ship our own JWT crypto.

## Code paths touched

### Types

**`types/next-auth.d.ts`** — extend `Session` and `JWT` to carry the
optional `impersonator` field. UI reads it from
`session.impersonator`; the server reads it from `token.impersonator`.

### Auth library

**`lib/auth.ts`** — extend `jwt()` and `session()` callbacks to
propagate `impersonator` (when present in the token, surface it in the
session; when issued via our new endpoints, write it to the token).

### New endpoints

**`app/api/admin/actions/impersonate/route.ts`** — POST handler per
the Start mechanism above. Requires `confirmEmail` to match.

**`app/api/admin/actions/stop-impersonating/route.ts`** — POST handler
per the Stop mechanism above. No body required.

### UI

**`components/impersonation-banner.tsx`** — new. Server component
that reads `auth()`, renders a red sticky banner above the top-nav
when `session.impersonator` is set, with target email, admin email,
"Stop" button (form POSTs to the stop endpoint), and a live countdown
to expiry.

**`app/dashboard/page.tsx`**, **`app/settings/page.tsx`**,
**`app/reasons/page.tsx`** — render `<ImpersonationBanner />` above
the existing `<TopNav />`.

**`app/admin/customers/[id]/customer-detail-client.tsx`** — add an
"Impersonate" button to the Emergency Actions section. Click → modal
with the merchant email pre-filled in a typed-confirm box → POST to
`/api/admin/actions/impersonate` → on success, navigate to
`/dashboard`.

### Audit / events

**`src/winback/lib/events.ts`** — no change to the helper itself.
Both endpoints call `logEvent` with the new event names.

## Edge cases

- **Admin opens a new tab while impersonating**: cookie is shared,
  new tab also acts as the merchant. Acceptable; this is how every
  cookie-based auth works.
- **Cookie auto-expires at 30 min**: next request 401s, NextAuth
  redirects to `/login`. Admin signs back in fresh.
- **Merchant happens to log in normally during impersonation**: their
  login overwrites the cookie with their own clean JWT. Admin's
  impersonation cookie is gone; impersonator field disappears. Stop
  endpoint would 400 ("no active impersonation") if admin clicks it
  from a stale tab; not a problem.
- **Admin clicks Impersonate while already impersonating**: start
  endpoint rejects ("active impersonation; stop first"). Banner
  always has Stop button visible, so this is a click away.
- **Target user not found / deleted mid-session**: start fails with
  404. Stop unaffected (it just restores adminId; admin's account
  better still exist).
- **`NEXTAUTH_SECRET` rotation mid-session**: all sessions
  invalidate, including impersonations. Admin re-signs in. Existing
  behavior, called out for completeness.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — add tests:
  1. `POST /impersonate` rejects without admin auth
  2. `POST /impersonate` rejects when `confirmEmail` doesn't match target
  3. `POST /impersonate` rejects when target is an admin
  4. `POST /impersonate` rejects when caller is already impersonating
  5. `POST /stop-impersonating` rejects when not impersonating
  6. Both endpoints write `admin_action` events with the new actions
- [ ] Manual smoke on dev:
  - Sign in as admin, navigate to `/admin/customers/<dev customer id>`
  - Click Impersonate, type the merchant email, submit
  - Dashboard renders as the merchant; banner across the top says
    "Impersonating <merchant email> as <admin email> · 29:58 → Stop"
  - Click Stop → return to `/admin/customers/<id>`
  - Check `/admin/audit-log` for both events
- [ ] No prod migration.

## Rollback

Revert the PR. No schema changes. Active impersonation cookies stay
valid until their natural 30-min TTL expires; their JWTs are still
HMAC-valid and the backend just keeps treating them as the target
user with an `impersonator` field that the UI no longer renders a
banner for. This is acceptable for short rollback windows.

## Phasing

Single PR. Estimated <500 LOC including spec doc + tests.

# Spec 29 — Password reset

**Phase:** Auth UX
**Depends on:** Spec 01 (database + NextAuth), Resend (already wired for outbound)
**Estimated time:** ~3 hours

---

## Context

Founders sign up with email + password (NextAuth v5 Credentials provider —
[lib/auth.ts](../lib/auth.ts)). There is currently no way to recover an account
if the password is lost. The login page only has "Sign in" and a "Register"
link — no "Forgot password?".

This spec adds a self-service password reset flow using a signed, single-use
token delivered by Resend (already used for win-back / dunning email so no new
infra).

---

## Goals

| # | Goal | Mechanism |
|---|---|---|
| 1 | A founder who forgot their password can reset it without human intervention | Email-link reset flow |
| 2 | Reset tokens cannot be reused, guessed, or stolen from the DB | Hashed token, single-use, 60-minute expiry |
| 3 | The endpoint cannot be used to enumerate which emails are registered | Same response for known / unknown email |
| 4 | The reset cannot be brute-forced or spammed | Rate limit per email + per IP |
| 5 | Active sessions are not silently hijacked after a reset | Existing JWT sessions remain valid; user is told to sign back in |

---

## Non-goals

- 2FA / MFA (separate spec if/when needed)
- "Magic link" passwordless sign-in
- Forced password rotation, complexity rules beyond the existing 8-char minimum
- Account lockout after N failed sign-in attempts (separate spec)
- Session invalidation on reset — JWT-only sessions don't have a server-side
  store to revoke. Acceptable risk: stolen sessions are short-lived (NextAuth
  default 30 days, but typical use is per-browser). Documented, not solved here.

---

## User flow

1. **Login page** — add a `Forgot password?` link below the password field,
   right-aligned, `text-sm text-blue-600 hover:underline`. Routes to
   `/forgot-password`.

2. **`/forgot-password`** — single-input form:
   `Email → [Send reset link]`. On submit, POSTs to
   `/api/auth/forgot-password`. Always shows the same confirmation:
   > If an account exists for that email, we've sent a reset link. Check your
   > inbox (and spam folder). The link expires in 60 minutes.

3. **Email** — plain text via Resend, from the same `noreply@winbackflow.co`
   sender used elsewhere. Subject: `Reset your Winback password`. Body:
   ```
   Someone requested a password reset for this Winback account.

   If it was you, click here to set a new password:
   {APP_URL}/reset-password?token={token}

   This link expires in 60 minutes and can only be used once.

   If you didn't request this, you can ignore this email — your password
   won't change.
   ```

4. **`/reset-password?token=…`** — server component validates the token
   exists, is unused, and is not expired. If invalid, render an error card
   ("This reset link has expired or has already been used. Request a new
   one.") with a button back to `/forgot-password`. If valid, render a form:
   `New password → Confirm password → [Update password]`.

5. **POST `/api/auth/reset-password`** — atomically: re-validates token,
   hashes new password (bcrypt cost 12, same as register), updates
   `wb_users.password_hash`, marks token used. Returns 200. UI redirects to
   `/login?reset=1` which renders a green banner: *Password updated. Sign in
   with your new password.*

---

## Database

New migration `024_password_reset_tokens.sql`:

```sql
CREATE TABLE wb_password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES wb_users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamp NOT NULL,
  used_at     timestamp,
  created_at  timestamp NOT NULL DEFAULT now(),
  ip_address  text
);

CREATE INDEX idx_pwreset_user_active
  ON wb_password_reset_tokens (user_id, created_at DESC)
  WHERE used_at IS NULL;
```

**Token generation:** `crypto.randomBytes(32).toString('base64url')` (43
chars, ~256 bits of entropy). Stored as `sha256(token)` hex — the raw token
only ever lives in the email link. DB compromise alone cannot mint a valid
reset link.

**Expiry:** `expires_at = now() + 60 minutes`. Lookups always check
`used_at IS NULL AND expires_at > now()`.

Drizzle schema addition in [lib/schema.ts](../lib/schema.ts):

```ts
export const passwordResetTokens = pgTable('wb_password_reset_tokens', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash:  text('token_hash').notNull().unique(),
  expiresAt:  timestamp('expires_at').notNull(),
  usedAt:     timestamp('used_at'),
  createdAt:  timestamp('created_at').notNull().defaultNow(),
  ipAddress:  text('ip_address'),
})
```

---

## API routes

### `POST /api/auth/forgot-password`

```
Body: { email: string }
Response (always 200): { ok: true }
```

Logic:
1. Zod validate `email`. Bad email → still return 200 (silent — don't leak).
2. Rate limit: deny with 200 (silent) if > 3 sends in the last 15 minutes
   for this email **or** > 10 sends in the last 15 minutes for this IP.
   Track counts in-memory (Edge runtime) or via a small `wb_rate_limits`
   table — prefer the table since Fluid Compute reuses instances but
   doesn't guarantee shared state. (Reuse pattern in
   [src/winback/lib/email.ts](../src/winback/lib/email.ts) if a similar
   limiter already exists; otherwise add a tiny inline implementation.)
3. Look up user by email. If none, log and return 200 — no email sent.
4. Invalidate any existing unused tokens for that user
   (`UPDATE … SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`).
   Prevents a stale link from staying valid after a fresh request.
5. Generate raw token, hash it, insert row with 60-min expiry and the
   request IP.
6. Send the Resend email with `{APP_URL}/reset-password?token={raw}`.
7. Return 200.

If the Resend call throws, return 200 anyway and log — we never want this
endpoint to surface "email exists" via differing latency / status.

### `POST /api/auth/reset-password`

```
Body: { token: string, password: string }
Response: { ok: true } | { error: string } (400 / 410)
```

Logic:
1. Zod validate (`token` non-empty string, `password` ≥ 8 chars).
2. Hash incoming token, look up `wb_password_reset_tokens` by `token_hash`.
3. If no row, or `used_at IS NOT NULL`, or `expires_at <= now()`:
   return `{ error: 'This reset link has expired or has already been used.' }`
   with status 410.
4. In a single transaction:
   - `UPDATE wb_users SET password_hash = $1 WHERE id = $2`
   - `UPDATE wb_password_reset_tokens SET used_at = now() WHERE id = $3`
5. Return `{ ok: true }`. Client navigates to `/login?reset=1`.

---

## Pages

### `app/forgot-password/page.tsx`

Server component shell, client form for the input. Match auth-page template
in [CLAUDE.md](../CLAUDE.md):
- `min-h-screen bg-[#f5f5f5]`, logo centered `mt-12 mb-8`
- `max-w-sm mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8`
- Title: `Reset your password.` (`text-4xl font-bold text-slate-900` —
  trailing period per design system)
- Subtitle: `text-sm text-slate-500` — *We'll email you a link to set a new
  password.*
- Email input + dark primary button (`Send reset link`)
- After submit: replace form with the generic confirmation message above
- Footer: `Back to sign in` link to `/login`

### `app/reset-password/page.tsx`

Server component:
- Reads `?token=` from `searchParams`
- Calls a server-side helper `validateResetToken(token)` (returns
  `{ ok: true } | { ok: false, reason }`) — same logic as the API but
  read-only, no `used_at` mutation
- If invalid: error card with "Request a new link" button → `/forgot-password`
- If valid: render client form (new password, confirm password). On submit,
  POST to `/api/auth/reset-password` then `router.push('/login?reset=1')`

### `app/login/page.tsx`

Two small additions:
1. Below the password field: right-aligned `Forgot password?` link to
   `/forgot-password`. `text-sm text-blue-600 hover:underline`.
2. If `searchParams.reset === '1'`: render a green banner above the form —
   `bg-green-50 text-green-700 border border-green-200 rounded-lg px-4 py-2.5 text-sm` —
   *Password updated. Sign in with your new password.*

---

## Email module

Reuse the existing Resend wrapper in
[src/winback/lib/email.ts](../src/winback/lib/email.ts). Add:

```ts
export async function sendPasswordResetEmail(opts: {
  to: string
  resetUrl: string
}): Promise<void>
```

Plain-text only. Same sender, same retry/idempotency wrapper used elsewhere.
No HTML version needed — it's a transactional auth email; plain text matches
the rest of the product.

---

## Tests

`src/winback/__tests__/password-reset.test.ts`:

- `validateResetToken`: returns `ok: false` for non-existent / used / expired
  tokens; `ok: true` for valid
- Token-hash collision impossible with random 32-byte token (skip)
- `forgot-password` route: unknown email → 200 with no email send
- `forgot-password` route: known email → 200, exactly one row inserted, exactly
  one Resend call made (mock the email module)
- `forgot-password` route: second request within 15 min for same email → 200
  but no Resend call (rate limit)
- `forgot-password` route: requesting a new token marks any prior unused
  token as `used_at`
- `reset-password` route: valid token → user's `password_hash` is updated
  (verify by `bcrypt.compare`), token row's `used_at` is set
- `reset-password` route: same token used twice → second call returns 410
- `reset-password` route: expired token → 410
- `reset-password` route: password < 8 chars → 400, no DB writes

---

## Verification before merge

Per CLAUDE.md:
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` green
- [ ] Migration 024 applied to Neon (show SQL, wait for "yes")
- [ ] Dev server walk-through:
  - Click `Forgot password?` from `/login` → submit own email
  - Receive Resend email (test domain), click link
  - Set new password, redirected to `/login?reset=1` with green banner
  - Sign in with new password works; old password no longer works
  - Click an already-used reset link → error card
  - Wait out / manually expire a token → error card
- [ ] PR opened, human says merge

---

## Out of scope (future)

- "Change password" while signed in (Settings page) — small follow-up, no
  email needed, just current-password + new-password form
- Server-side session revocation on reset (requires moving sessions off JWT)
- Email change flow (separate confirm-old, confirm-new dance)

# Spec 32 — Email verification (single code path, dev + prod)

**Phase:** Pre-launch hardening
**Depends on:** Spec 25 (admin role), Spec 29 (token-model precedent — `wb_password_reset_tokens`), Spec 30 (Resend founder-email pattern), Spec 31 (active pilot accounts that need backfill)
**Estimated time:** ~3 hours

---

## Context

Today, `POST /api/auth/register` creates a `wb_users` row from any
email + password pair without proving the founder owns the email. Three
consequences in production:

1. **Typo'd email = bricked account.** They can't password-reset
   (the link goes nowhere), they don't receive recovery alerts,
   and our Spec-30 onboarding-followup nudge fires emails into the void.
2. **Account squatting.** A malicious actor pre-registers your work
   email; you hit `409 Email already registered` and can't claim it
   without password-resetting from an inbox you don't control.
3. **No way to ever know the email is reachable** before we start
   acting on it (sending recovery alerts, billing receipts, etc).

This spec adds email verification with a **single code path across dev
and prod** — no env-driven branching. Every signup sends a verification
email; login refuses unverified accounts. The 4 currently-active pilot
founders (Spec 31) are auto-verified in the migration since we already
trust them.

---

## Goals

| # | Goal | Mechanism |
|---|------|-----------|
| 1 | Founder must prove email ownership before logging in | `wb_users.email_verified_at` checked in NextAuth `authorize` callback |
| 2 | Same code path in dev + prod (no env-driven bypass) | No new env vars; the database column is the only source of truth |
| 3 | Existing trusted accounts skip the wall | Migration 027 backfills `email_verified_at = now()` for all rows that exist when it runs |
| 4 | Unverified users have a clear path to recover | Login surfaces "please verify" inline + a "Resend verification" button |
| 5 | Token security matches Spec 29's bar | sha256-in-DB, atomic conditional consume, 7-day TTL, single-use, prior tokens invalidated on resend |

---

## Non-goals

- **2FA / TOTP** — separate spec when we get there
- **Email-change flow** post-signup — we don't currently support changing email on an existing account; not in scope here
- **Allowing legacy unverified accounts to skip verification forever** —
  the backfill in migration 027 is one-shot. Any account created after
  the migration lands needs to verify, no exceptions
- **Soft-launch / staged rollout** — this is the right behavior in dev
  the same as in prod; rolling it out in stages would require the
  env-driven branching this spec deliberately avoids

---

## Detection (single SQL truth)

```sql
-- Unverified accounts (post-launch, this should always trend toward zero)
SELECT u.email, u.created_at,
       (now() - u.created_at) AS pending_for
FROM   wb_users u
WHERE  u.email_verified_at IS NULL
ORDER  BY u.created_at DESC;
```

---

## Database — migration 027

```sql
ALTER TABLE wb_users
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;

-- Backfill: every existing user is implicitly trusted (4 active pilots
-- + tejaasvi admin + tkedambadi support + any test accounts). Spec 31
-- shipped on 2026-04-28; this migration runs after that.
UPDATE wb_users
SET    email_verified_at = now()
WHERE  email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS wb_email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES wb_users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamp NOT NULL,
  used_at     timestamp,
  created_at  timestamp NOT NULL DEFAULT now(),
  ip_address  text
);

-- Active-token lookup per user (for invalidate-prior-on-resend).
CREATE INDEX IF NOT EXISTS idx_email_verif_user_active
  ON wb_email_verification_tokens (user_id, created_at DESC)
  WHERE used_at IS NULL;
```

Drizzle: add `emailVerifiedAt: timestamp('email_verified_at')` to the
`users` pgTable and a new `emailVerificationTokens` table mirroring the
existing `passwordResetTokens` shape.

---

## Token model

Mirrors Spec 29 password-reset. New `src/winback/lib/email-verification.ts`:

- `generateRawToken()` — 256-bit base64url
- `hashToken(raw)` — sha256 hex, only the hash hits the DB
- `validateVerificationToken(raw)` — read-only; returns `{ ok: true, tokenId, userId }` or `{ ok: false, reason: 'not-found' | 'used' | 'expired' }`
- `consumeVerificationToken(raw)` — atomic conditional UPDATE: returns `userId` if `used_at IS NULL AND expires_at > now()`, else null
- `issueVerificationToken({ userId, ipAddress })` — invalidates any prior unused tokens for that user, then inserts a new one with 7-day expiry
- **TTL: 7 days.** Longer than password reset (24h) because this is a one-time confirmation, not a sensitive recovery; we don't want a slow-inbox founder to be locked out

---

## Register flow changes

[app/api/auth/register/route.ts](../app/api/auth/register/route.ts):

After the existing user/customer/legalAcceptances/pilot inserts and
before the `register_completed` event:

```ts
// Spec 32 — issue a verification token and email the link.
const ipAddress = req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? null
const rawToken = await issueVerificationToken({ userId: newUser.id, ipAddress })
const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://winbackflow.co'
const verifyUrl = `${base}/verify-email?token=${encodeURIComponent(rawToken)}`
try {
  await sendVerificationEmail({ to: email, founderName: name, verifyUrl })
} catch (err) {
  // Same posture as Spec 29 password reset: log and proceed; the user
  // can hit "resend verification" from the login page if it never arrives.
  console.error('[register] verification email send failed:', err)
}
```

The user is created with `email_verified_at = NULL` (default) regardless
of dev/prod. The verification email is sent regardless of dev/prod. No
env-var gating anywhere.

---

## Verify-email page

`/verify-email?token=…` — server component, mirrors `/reset-password`:

- `export const dynamic = 'force-dynamic'` — token state changes on consume; never cache
- Reads `?token=` from `searchParams`, calls `consumeVerificationToken`
- On success: server-side `redirect('/login?verified=1')`
- On failure: error card *"This verification link has expired or has already been used. Sign in to resend."* with a button back to `/login`

The `/login?verified=1` banner shows: *"Email verified — please sign in."*
(Symmetric with the Spec-29 `?reset=1` banner.)

---

## Login flow changes

[lib/auth.ts](../lib/auth.ts):

After the bcrypt check in the credentials provider's `authorize`
callback, also check `email_verified_at`:

```ts
if (!user.emailVerifiedAt) {
  // Custom NextAuth error code — surfaces in signIn result so the
  // login form can render a meaningful message + resend button rather
  // than the generic "Invalid email or password".
  throw new UnverifiedEmailError()
}
```

Where `UnverifiedEmailError` is a tiny subclass:

```ts
import { CredentialsSignin } from 'next-auth'
class UnverifiedEmailError extends CredentialsSignin {
  code = 'UNVERIFIED_EMAIL'
}
```

[app/login/page.tsx](../app/login/page.tsx) reads the result code and
swaps the error UI:

- If `result.code === 'UNVERIFIED_EMAIL'`:
  - Show: *"Please verify your email — we sent a link to {email}."*
  - Render a **Resend verification email** button (calls `/api/auth/resend-verification`)
- Else (true bad credentials): existing *"Invalid email or password."*

The login form's existing native-form-POST fallback (Spec 29) is
preserved — the server-action path returns the same code and the page
re-renders with `?error=UNVERIFIED_EMAIL` (or similar) so unverified
users without JS still get the right messaging.

---

## Resend-verification endpoint

`POST /api/auth/resend-verification` — mirrors Spec 29 `/api/auth/forgot-password`:

- Body: `{ email: string }`
- **Always returns 200** (no account enumeration)
- Rate limit: 3 / email / 15 min, computed via the existing pattern
- If user found AND `email_verified_at IS NULL`:
  - Invalidate any prior unused verification tokens
  - Issue a fresh one
  - Send the verification email
- If user is already verified or doesn't exist: silent no-op (still 200)

Form-encoded path (no JS) → 303 redirect to `/login?verifySent=1`
showing *"Check your inbox — we sent a fresh link."*. JSON path → `{ ok: true }`.

---

## Email template

`src/winback/lib/email.ts`, alongside `sendPasswordResetEmail`:

```ts
export async function sendVerificationEmail(opts: {
  to: string
  founderName: string | null
  verifyUrl: string
}): Promise<void>
```

From `Winback <support@winbackflow.co>` (replies welcome — same posture
as the other founder-aimed transactional emails). Plain text:

```
Hi {founderName ?? 'there'},

Welcome to Winback. Click the link below to confirm your email and
finish creating your account:

{verifyUrl}

This link expires in 7 days. If you didn't sign up for Winback, you can
safely ignore this email.

— The Winback team
```

Wrap in `callWithRetry` for 429 handling, like the rest of email.ts.

---

## Tests

Pattern: `vi.hoisted` mocks of `@/lib/db`, `@/lib/schema`, `drizzle-orm` —
mirrors `password-reset.test.ts` and `password-reset-routes.test.ts`.

`src/winback/__tests__/email-verification-token.test.ts` (~10 tests):
- generate / hash / validate (not-found, used, expired, valid)
- consume (atomic — returns null on race)
- issueVerificationToken invalidates prior unused for same user
- TTL is 7 days

`src/winback/__tests__/email-verification-routes.test.ts` (~8 tests):
- register: creates user with `email_verified_at = NULL` + sends email
- register: swallows email-send failure (account still created)
- verify: valid token → redirect to `/login?verified=1` + sets timestamp
- verify: invalid token → error page
- verify: replay (same token used twice) → second call shows error
- resend: unknown email → 200, no email sent (no enumeration)
- resend: known unverified email → 200 + email sent + prior token invalidated
- resend: already verified email → 200 silently (no email sent)

`src/winback/__tests__/login-unverified.test.ts` (~3 tests):
- login refuses unverified user with `UnverifiedEmailError` code
- login allows verified user (same as today)
- login still rejects bad password regardless of verified state

---

## Verification before merge

Per CLAUDE.md merge discipline:

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green
- [ ] Migration 027 applied to Neon (show SQL, wait for "yes")
- [ ] Confirm backfill: `SELECT count(*) FROM wb_users WHERE email_verified_at IS NULL` returns **0** before any new signups
- [ ] Manual click-through:
  - Register a fresh test account (`tejaasvi+verify1@gmail.com`)
  - Confirm verification email arrives + `email_verified_at` is null in DB
  - Try logging in → see "please verify your email" + resend button
  - Click resend → fresh email arrives, prior token marked used
  - Click verify link → land on `/login?verified=1` banner; `email_verified_at` is now set
  - Log in → success
- [ ] Confirm one of the 4 active pilots (e.g. `tejaasvi+pilot1@gmail.com`)
      can still sign in — backfill worked
- [ ] PR opens with explicit migration callout, human says "merge"

---

## Edge cases handled

1. **Bot signup floods the verification-email queue** — the rate limit
   on `/api/auth/resend-verification` is 3/email/15min; the bot would
   need to register N accounts to send N emails. We accept this — the
   register endpoint itself isn't rate-limited yet, and that's a
   separate spec when bot abuse becomes a real signal.
2. **Founder loses access to the email account they registered with** —
   account is permanently locked from their side. They can register
   fresh with a new address. No "change email" UX in v1; logged as
   future work.
3. **Founder clicks an already-used verify link** — the token's
   `used_at` is set, atomic consume returns null, page renders the
   "expired or already used" card. They can navigate to login and use
   the resend button if they're somehow still unverified, but if they
   already used the link they're already verified — login should work.
4. **Race**: founder clicks the verify link in two tabs simultaneously.
   Only one consume succeeds. The losing tab sees "already used" — but
   the user is verified anyway. Acceptable.
5. **Pilot redemption + verification** — these are independent. A
   pilot founder still needs to verify their email before login. The
   pilot bypass affects billing, not authentication.
6. **Spec-30 onboarding nudges** — the Day-3 nudge cron checks
   `customers.stripe_account_id IS NULL`, not `users.email_verified_at`.
   An unverified founder who can't log in also won't connect Stripe,
   so they'll get nudged. That's actually fine: the nudge email *is*
   their reminder to verify.

---

## Out of scope (future)

- 2FA / TOTP
- Email-change flow on existing accounts
- Per-route observability for verification funnel (could log
  `email_verified` event in addition to setting the column)
- Soft-disable verification for staging environment via env var (this
  spec explicitly avoids env-driven branching; revisit if a real need
  appears)

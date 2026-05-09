# Spec 48 — Capture Stripe OAuth token-exchange error detail in `oauth_error` events

## Context

When a merchant goes through `/onboarding/stripe` and OAuth fails at the
token-exchange step (`POST https://connect.stripe.com/oauth/token`), the
callback handler at
[app/api/stripe/callback/route.ts:54-62](../app/api/stripe/callback/route.ts#L54)
currently logs only:

```ts
{ errorType: 'token_exchange_failed' }
```

The actual reason from Stripe — "invalid_grant: Authorization code already
used", "Cannot connect to a related account", etc. — is in the response
body and **never recorded anywhere**. Today (2026-05-09) we hit this
exact failure during the live-mode smoke test and had to hand-walk the
user through Stripe Dashboard → Developers → Logs to find the cause.
That's a bad day-1 experience: when a real merchant hits this in the
wild, support won't have any signal.

This spec captures the Stripe response detail in the `oauth_error`
properties so future failures self-diagnose from `/admin/events`.

## Goals

- When token exchange fails, the `oauth_error` event includes:
  - `httpStatus` — the HTTP status from Stripe (e.g. 400, 401)
  - `stripeError` — the OAuth `error` code (e.g. `"invalid_grant"`)
  - `stripeErrorDescription` — the human-readable `error_description`
  - `stripeMessage` — Stripe API-style `error.message` if the response
    is shaped that way instead of OAuth-style
- Resilient to non-JSON responses (HTML error pages, empty bodies):
  capture a truncated text snippet as `responseSnippet` instead of
  crashing.
- No PII leak: the OAuth `code` is never logged (it's already burned by
  this point and short-lived, but still).

## Non-goals

- No retry logic. If Stripe says "invalid_grant" the code is dead — we
  can't retry. The user has to restart OAuth.
- No `try/catch` wrap around `fetch()` itself. A network error throwing
  out of `fetch` is a separate concern (handler currently 500s, which is
  a fine signal). Keep this spec focused on the "Stripe responded with
  non-OK" path.
- No spec-wide refactor of the callback handler. Only the error-handling
  branch changes.
- No new tests. The change is observability-only and the parse logic is
  trivially safe; existing tests (which don't exercise the route handler
  at HTTP level) remain unchanged.

## Schema / migration

None. `wb_events.properties` is JSONB — new fields ride alongside
existing ones automatically.

## Code paths touched

### [app/api/stripe/callback/route.ts](../app/api/stripe/callback/route.ts) — replace the existing `if (!tokenRes.ok) { ... }` block

Replace:

```ts
  if (!tokenRes.ok) {
    await logEvent({
      name: 'oauth_error',
      customerId: customer.id,
      userId: customer.userId,
      properties: { errorType: 'token_exchange_failed' },
    })
    return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=token_exchange_failed`)
  }
```

With:

```ts
  if (!tokenRes.ok) {
    // Capture Stripe's response detail so /admin/events shows the real
    // cause (invalid_grant, related-account block, expired code, etc.)
    // instead of just "token_exchange_failed".
    const httpStatus = tokenRes.status
    const rawText = await tokenRes.text().catch(() => '')
    let stripeError: string | null = null
    let stripeErrorDescription: string | null = null
    let stripeMessage: string | null = null
    let parsedJson: unknown = null
    try {
      parsedJson = JSON.parse(rawText)
    } catch {
      // Stripe returned non-JSON (HTML error page, empty, etc.) — fall
      // through to responseSnippet only.
    }
    if (parsedJson && typeof parsedJson === 'object') {
      const j = parsedJson as Record<string, unknown>
      stripeError = typeof j.error === 'string' ? j.error : null
      stripeErrorDescription = typeof j.error_description === 'string' ? j.error_description : null
      // Stripe API-shaped error: { error: { type, message } }
      if (!stripeError && j.error && typeof j.error === 'object') {
        const nested = j.error as Record<string, unknown>
        stripeMessage = typeof nested.message === 'string' ? nested.message : null
        stripeError = typeof nested.type === 'string' ? nested.type : null
      }
    }

    await logEvent({
      name: 'oauth_error',
      customerId: customer.id,
      userId: customer.userId,
      properties: {
        errorType: 'token_exchange_failed',
        httpStatus,
        stripeError,
        stripeErrorDescription,
        stripeMessage,
        responseSnippet: rawText.slice(0, 500),
      },
    })
    return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=token_exchange_failed`)
  }
```

The change is contained to that single block. No other lines of the
handler move.

## Edge cases handled

| Case | Behavior |
|---|---|
| Stripe returns standard OAuth error JSON `{error, error_description}` | Both fields captured directly |
| Stripe returns API-shaped error `{error: {type, message}}` | `stripeError` ← `error.type`, `stripeMessage` ← `error.message` |
| Stripe returns non-JSON (HTML, empty) | `parsedJson` stays null; `responseSnippet` carries the first 500 chars; structured fields stay null |
| Stripe returns 200 with success body | This branch doesn't run (we're inside `if (!tokenRes.ok)`) |
| Response body is huge | Truncated to 500 chars in `responseSnippet`. Sufficient for any real Stripe error. |
| Body read fails (e.g. ECONNRESET mid-stream) | `.catch(() => '')` returns empty string; downstream parsing degrades gracefully. |

## Verification

### Pre-merge (on branch)

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green (unchanged — no test file touches the route handler at HTTP level)
- [ ] Diff is ONLY the replacement block in §1 above — no other edits

### Post-merge

- [ ] Trigger a deliberate token-exchange failure (easiest: have user start OAuth, but visit `/api/stripe/callback?code=invalid&state=<real-customer-id>` directly to use a bad code)
- [ ] Verify `/admin/events` shows an `oauth_error` row with populated `httpStatus`, `stripeError`, `stripeErrorDescription`
- [ ] Re-attempt the original failing OAuth that triggered this spec — confirm we now see why the same-entity OAuth was rejected

## Branch + PR

- Branch: `feat/spec-48-oauth-error-detail`
- PR title: `Spec 48: capture Stripe OAuth error detail in oauth_error events`

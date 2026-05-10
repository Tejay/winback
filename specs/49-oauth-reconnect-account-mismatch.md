# Spec 49 — OAuth reconnect: trust the new account ID, trigger backfill on change

## Context

[app/api/stripe/callback/route.ts:68-75](../app/api/stripe/callback/route.ts#L68)
has a "reconnect" branch that — unintentionally — keeps the **old**
Stripe account ID even when OAuth returned a different one:

```ts
// Handle reconnect: keep original account ID if one exists
const accountIdToSave = customer.stripeAccountId ?? newAccountId
if (customer.stripeAccountId && customer.stripeAccountId !== newAccountId) {
  console.warn(
    `Stripe reconnect: user ${customer.id} had account ${customer.stripeAccountId}, ` +
    `OAuth returned ${newAccountId}. Keeping original account ID.`
  )
}
```

The original intent was: "if a merchant disconnects and reconnects the
**same** Stripe account, don't break foreign-key references in
`wb_churned_subscribers`." But the implementation keeps the old ID even
when accounts genuinely differ — it just logs a warning and proceeds.

### Failure mode

When a Winback user re-OAuths to a **different** Stripe account without
explicitly disconnecting first (which happens any time someone
re-authorizes from `/onboarding/stripe` while still connected — e.g.,
moving from a sandbox account to a live account), our DB ends up with:

- `stripeAccountId` = **A** (the old account, stale)
- `stripeAccessToken` = encrypted token for **B** (the new account)

The token can call Stripe as B, but our customer row claims to be A.
Then when webhooks fire from account **B**, [`processChurn`](../app/api/stripe/webhook/route.ts#L175)
does `WHERE stripeAccountId = B` against the `customers` table → finds
nothing → logs `"Unknown Stripe account"` → **the event is silently
dropped.** Real cancellations from the new merchant never reach the
pipeline.

This is exactly what manifested in last night's smoke test. The
`testfounder.winback@gmail.com` workspace had a sandbox account ID
stored from earlier testing; reconnecting in live mode kept the old ID,
so live webhooks would have been silently dropped.

(Note: the bug only fires on reconnect *without* explicit disconnect.
[disconnect/route.ts](../app/api/stripe/disconnect/route.ts) clears both
fields to null, after which the next OAuth is treated as a first connect.
Since the in-product disconnect flow is buried in `/settings`, most
users hitting "reconnect" probably don't take that path first.)

## Goals

- The callback handler always saves the account ID returned by OAuth, never an existing stale one.
- A reconnect to a **different** account triggers a fresh backfill against the new account (currently this doesn't happen — backfill only fires on first connect, where `customer.stripeAccountId` is null).
- A reconnect to the **same** account skips the backfill (idempotent — same merchant, same data, no need to re-import).
- Existing observability is preserved (the `console.warn` was useful when it fired; we keep it, just for the same-vs-different-account distinction).

## Non-goals

- **No cleanup of stale `wb_churned_subscribers` rows from a previous account.** Adding that would require either deletion (destructive) or an `archived` status that doesn't exist in the schema today (would touch the `status` text type, dashboard filters, admin views, and TS types). Scope it for a follow-up spec if/when this becomes a real complaint. The data-hygiene concern is real but is the same-Winback-user-seeing-their-own-prior-data case — not a privacy/leakage issue. Old rows persist and may surface in the dashboard until they age out or are manually archived.
- **No schema changes.**
- **No new tests.** The existing route handler isn't HTTP-tested anywhere in the suite, and the change is small. Verification is via the post-deploy smoke test below.
- **No refactor** of the broader callback handler.

## Code paths touched

### [app/api/stripe/callback/route.ts](../app/api/stripe/callback/route.ts) — replace the reconnect block

Currently:

```ts
  // Handle reconnect: keep original account ID if one exists
  const accountIdToSave = customer.stripeAccountId ?? newAccountId
  if (customer.stripeAccountId && customer.stripeAccountId !== newAccountId) {
    console.warn(
      `Stripe reconnect: user ${customer.id} had account ${customer.stripeAccountId}, ` +
      `OAuth returned ${newAccountId}. Keeping original account ID.`
    )
  }

  await db
    .update(customers)
    .set({
      stripeAccountId: accountIdToSave,
      stripeAccessToken: encrypt(accessToken),
      onboardingComplete: true,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, state))

  const firstConnect = !customer.stripeAccountId

  // Trigger historical backfill on first connect (fire-and-forget via internal API)
  if (firstConnect) {
    ...
  }
```

Replace with:

```ts
  // Spec 49 — always trust OAuth's response. The previous "keep original
  // ID" path silently dropped webhooks when a merchant reconnected to a
  // different Stripe account.
  const previousAccountId = customer.stripeAccountId
  const accountChanged = previousAccountId !== null && previousAccountId !== newAccountId
  const firstConnect = !previousAccountId
  const needsBackfill = firstConnect || accountChanged

  if (accountChanged) {
    console.warn(
      `Stripe reconnect: user ${customer.id} switched from account ${previousAccountId} ` +
      `to ${newAccountId}. Backfilling against the new account; old churned_subscribers rows ` +
      `(tied to ${previousAccountId}) remain in DB.`
    )
    logEvent({
      name: 'oauth_account_changed',
      customerId: customer.id,
      userId: customer.userId,
      properties: { previousAccountId, newAccountId },
    })
  }

  await db
    .update(customers)
    .set({
      stripeAccountId: newAccountId,
      stripeAccessToken: encrypt(accessToken),
      onboardingComplete: true,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, state))

  // Trigger historical backfill on first connect or when the account changed.
  if (needsBackfill) {
    ...
  }
```

The `if (firstConnect)` block becomes `if (needsBackfill)`. Everything inside that block is unchanged.

## Edge cases handled

| Case | Old behavior | New behavior |
|---|---|---|
| First-time connect | Save new ID; trigger backfill | Same |
| Disconnect → reconnect same account | Save new ID; trigger backfill | Same |
| Reconnect same account (no disconnect) | Keep existing ID; no backfill | Same (account unchanged → `accountChanged` false → no backfill) |
| Reconnect **different** account (no disconnect) | **Keep stale ID** + new token → silent webhook drop | Save new ID + new token; trigger backfill on the new account; emit `oauth_account_changed` event for observability |
| Reconnect after `/api/stripe/disconnect` | Save new ID; trigger backfill | Same |

## Schema / migration

None.

## Verification

### Pre-merge (on branch)

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green (existing 505 tests, none touch this code path at HTTP level, all should pass unchanged)
- [ ] Diff is exactly the block in §1 — no other edits

### Post-merge smoke

- [ ] Deploy to production
- [ ] Verify the existing live merchant connection (testfounder.winback@gmail.com → Fitness App, `acct_1TKz5vBpTKxrWhMg`) still works on subsequent webhook events
- [ ] **Optional active test** — disconnect from `/settings`, reconnect to a different Stripe account if available; confirm:
  - `customers.stripeAccountId` updates to the new value (DB query or admin tools)
  - `oauth_account_changed` event appears in `/admin/events`
  - Backfill is triggered against the new account

### Observability after deploy

- [ ] Watch `/admin/events` for the first day for any unexpected `oauth_account_changed` rows. (For a clean launch with new merchants, none should appear unless someone genuinely reconnects to a different account.)

## Branch + PR

- Branch: `feat/spec-49-oauth-reconnect-account-mismatch`
- PR title: `Spec 49: trust OAuth account ID on reconnect, trigger backfill on account change`

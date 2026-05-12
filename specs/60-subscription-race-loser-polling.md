# Spec 60 — Subscription race-loser: poll instead of sleep-once

## Context

Tier 2.2 (success page vs webhook wrapper race) confirmed all
billing-correctness invariants hold, but surfaced a **UX regression**:
the race-loser inside `ensurePlatformSubscription` sleeps once for
`SUBSCRIPTION_CREATION_RACE_WAIT_MS = 1_000ms`, then re-reads the DB
once, and throws if the winner hasn't finished yet.

Observed in the Tier 2.2 run:

```
success-page  status=caught   duration=3531ms  err="subscription_creation_in_progress"
webhook       status=success  duration=6185ms  (won the race, took 6.2s end-to-end)
```

The success-page-loser woke up at t=3.5s, re-read, saw the winner still
working, and gave up. The winner finished 2.5s later. **The user
landed on a "pending — refresh in a moment" page when they could have
seen "active" two and a half seconds later.**

Billing was correct — one subscription, one perf fee, no double charge.
But the user-facing confirmation page lost the chance to render the
right state.

## Goals

- Replace the single-sleep-then-read with a **bounded polling loop**:
  check every `RACE_POLL_INTERVAL_MS` for up to `RACE_TOTAL_WAIT_MS`.
- Pick values that fit realistic Stripe API latency:
  - Poll interval: **500ms** (cheap — one DB SELECT per tick)
  - Total wait: **10s** (covers observed worst-case 6.2s + headroom)
- Loser returns the winner's `subscriptionId` as soon as it's written
  (not "at the next sleep boundary"). For the median case where the
  winner finishes in 2s, the loser returns at ~2.0-2.5s instead of
  waiting the full window.
- Same throw behaviour after the total wait expires (preserves the
  upstream `try/catch` semantics in `/billing/success` and the webhook
  handler).

## Non-goals

- **No change to the winner's path.** It claims, calls Stripe, writes
  back, clears the lock — identical to today.
- **No change to the lock TTL** (30s). That's for crash recovery,
  independent of the loser's wait.
- **No change to the perf-fee race-loser** (Spec 58). That path
  doesn't wait — it returns `skipped='race'` immediately. No change
  needed.

## Code paths touched

| File | Change |
|---|---|
| `src/winback/lib/subscription.ts` | Replace the `await new Promise(setTimeout)` + one re-read with a `while (Date.now() < deadline)` polling loop. Replace `SUBSCRIPTION_CREATION_RACE_WAIT_MS` with `SUBSCRIPTION_CREATION_RACE_POLL_INTERVAL_MS = 500` and `SUBSCRIPTION_CREATION_RACE_TOTAL_WAIT_MS = 10_000`. |
| `src/winback/__tests__/subscription.test.ts` | Update the existing race-loser test cases (subscriber finishes before / after the wait window) — the wait window is now polling, so finishing at 2s should return cleanly, finishing past 10s should throw. |

## Refactor (illustrative)

```ts
const SUBSCRIPTION_CREATION_RACE_POLL_INTERVAL_MS = 500
const SUBSCRIPTION_CREATION_RACE_TOTAL_WAIT_MS = 10_000

if (claimed.length === 0) {
  // Lost the race. Poll for the winner to finish writing the sub id.
  const deadline = Date.now() + SUBSCRIPTION_CREATION_RACE_TOTAL_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, SUBSCRIPTION_CREATION_RACE_POLL_INTERVAL_MS),
    )
    const [after] = await db
      .select({ stripeSubscriptionId: customers.stripeSubscriptionId })
      .from(customers)
      .where(eq(customers.id, wbCustomerId))
      .limit(1)
    if (after?.stripeSubscriptionId) {
      return { subscriptionId: after.stripeSubscriptionId, created: false }
    }
  }
  throw new Error(
    `ensurePlatformSubscription: subscription_creation_in_progress for ${wbCustomerId}`,
  )
}
```

## Edge cases handled

1. **Winner finishes fast (< 500ms)** — first poll catches it; loser
   returns in ~500ms instead of waiting the old 1000ms. Slight win.
2. **Winner takes 2-5s (the realistic case)** — loser returns within
   ~500ms of the winner's write. **Today's main fix.**
3. **Winner takes >10s (rare — Stripe back-pressure)** — loser throws
   after 10s. Same as today, just later. The upstream `try/catch`
   renders "pending" tone, user refreshes.
4. **Winner's lock TTL expires (30s, crash recovery)** — out of scope
   for the loser branch; a different caller reclaims. Loser will have
   thrown at the 10s mark, upstream handled.
5. **DB unavailable mid-poll** — each `db.select` can throw; this
   propagates out (no swallowing). Caller's `try/catch` handles it
   the same as today.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — existing race tests still pass with adjusted
      timing assumptions; new sub-second-winner case added
- [ ] **E2E:** re-run `scripts/billing-test-tier2-wrapper-race.ts` after
      the fix. Expect:
  - success-page status=`success` (state=`active`, subCreated=`false`)
  - webhook status=`success` (state=`active`, subCreated=`true`)
  - both paths converge on the same `subId`
  - success-page's duration is now ≤ webhook's duration + ~500ms
    (the loser returns shortly after the winner)
  - all 6 invariants from Tier 2.2 still hold

## Why this matters

The two-path architecture (success page + webhook, Stripe-recommended)
is correct. This is a UX-only polish that closes the gap between
"both paths converged correctly" and "the user-visible page reflects
that convergence." It costs at most 20 cheap DB SELECTs in the rare
worst case, gains a much more reliable "active" render on success.

## Out of scope

- Switching to a single-path architecture (Options A or B from the
  earlier discussion). Two-path with idempotent activation is
  Stripe's recommended pattern.
- Changing what the "pending" tone copy says (separate UX concern).
- Adding client-side auto-refresh on the pending page (separate UX
  concern).

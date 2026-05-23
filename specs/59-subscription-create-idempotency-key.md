> **⚠️ Historical reference — pricing model was rewritten on 2026-05-23.**
> The "$99/mo + 1× MRR per recovery" and "14-day refund window" mechanics
> described in this doc no longer exist. Current model: tiered flat
> monthly fee priced by the customer's own MRR (Starter $99 / Growth
> $299 / Scale $699 / Enterprise sales-handled), no per-recovery
> charges, no refund windows. See `CLAUDE.md` and
> `/Users/tejay/.claude/plans/we-are-going-to-memoized-kernighan.md`
> for the current model. This doc is preserved as historical record.

# Spec 59 — Subscription create: Stripe idempotency key

## Context

Spec 58 added a Stripe `Idempotency-Key` header to
`stripe.invoiceItems.create` (for perf fees) — belt-and-suspenders
that catches duplicates if the DB race-fence ever leaks. The
**subscription creation path is asymmetrically protected**: its DB
race-fence (Spec 52) holds, but it doesn't pass an idempotency key to
`stripe.subscriptions.create`. Closing that gap is the symmetric fix
the user flagged after we shipped Spec 58.

What we proved earlier: the Spec 52 DB fence holds under 5 parallel
callers (Tier 2.1). What it doesn't protect against:

1. **Stripe SDK auto-retries on transient network errors.** The SDK
   retries some idempotent failures (5xx, network reset, timeout)
   automatically. Without an explicit `Idempotency-Key`, each retry
   creates a **new** subscription. The merchant gets billed twice.
2. **Upstream wrapping retries** (e.g., a future code path that wraps
   `ensurePlatformSubscription` in a try/catch + retry). Same issue.
3. **A theoretical fence regression** (refactor accidentally drops
   the WHERE clause). The DB fence stops working; idempotency would
   catch it.

For all three, the same `Idempotency-Key` strategy that Spec 58
applied to invoice items works.

## Goals

- Pass `Idempotency-Key: wb-sub-${wbCustomerId}-${claimedAt.getTime()}`
  to `stripe.subscriptions.create` in `ensurePlatformSubscription`.
- Use the existing `claimedAt` timestamp from the Spec 52 race-fence
  claim — no new column, no new state.

## Non-goals

- **No DB-fence change.** Spec 52's fence is proven and remains the
  primary protection.
- **No schema change.** Reuse `stripeSubscriptionCreatingAt` (already
  set at claim time) as the key's epoch component.
- **No retroactive key for past subscriptions.** Already-created subs
  are unaffected.

## Choice of key

`wb-sub-${wbCustomerId}-${claimedAt.getTime()}`

| Property | Why |
|---|---|
| Stable within one ensurePlatformSubscription call | SDK retries during this call inherit the same key — Stripe dedupes |
| Different across cancel + re-activate cycles | Each new lock claim has a fresh `claimedAt` → fresh key → Stripe creates a fresh subscription (no cached-canceled-sub trap) |
| Bound to the lock-winner | Only one caller per claim window has this exact timestamp |
| Customer-scoped | Different customers never collide |

Why **not** just `wb-sub-${customerId}`: Stripe caches the response
for 24h. If the customer cancels their platform sub and re-activates
within 24h (rare but possible), the cache would return the *canceled*
subscription as "active," corrupting our DB.

Why **not** include `activatedAt` epoch (the once-set "first
recovery" timestamp): same trap — it's sticky, so cancel + re-activate
would reuse the cache.

## Code paths touched

| File | Change |
|---|---|
| `src/winback/lib/subscription.ts` | Inside `ensurePlatformSubscription`, after `claimedAt` is set, pass `{ idempotencyKey: \`wb-sub-${wbCustomerId}-${claimedAt.getTime()}\` }` as the second arg to `stripe.subscriptions.create` |
| `src/winback/__tests__/subscription.test.ts` (or wherever the existing test lives) | Verify the create call is made with that idempotency key |

## Edge cases handled

1. **Normal path** — claim wins, Stripe POST with key, write sub id.
2. **SDK auto-retry during a 5xx** — retry inherits the same key, Stripe returns the original (or completes the create if it never finished); one subscription net.
3. **Cancel + re-activate** — second activation gets a fresh `claimedAt`, fresh key, fresh subscription.
4. **Fence leak (theoretical)** — two callers reach Stripe with **different** keys (their claimedAt values differ because Postgres serializes the UPDATE). The idempotency key doesn't dedupe across keys — so it does NOT protect this case. The DB fence is the only defender. Accept this gap: if the fence regresses we have bigger problems. The key still helps cases 2 and the theoretical "same caller retries" scenario, which is the realistic operational risk.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — extend the subscription test to assert the
      idempotency key is the second arg; existing cases still pass
- [ ] Manual: re-run `scripts/billing-test-tier2-race-fence.ts`
      against dev; expect the same result as today (1 subscription,
      both fences hold). The change adds defense, doesn't alter the
      visible outcome.

## Out of scope

- General audit of other `stripe.X.create` call sites for similar
  gaps (already on the todo list as a follow-up to Spec 58).
- Adding idempotency to refund / credit-note paths (those have their
  own idempotency story via `perf_fee_refunded_at`).

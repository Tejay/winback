# Spec 58 — Performance-fee charging: race-fence + idempotency

## Context

While running the Tier 2.1 race-fence test on 2026-05-12, we proved
the Spec 52 subscription race-fence holds under concurrent
`ensureActivation` calls, but **also surfaced a second, separate race**
in `chargePerformanceFee`:

```
5 parallel ensureActivation calls →
  exactly 1 Stripe subscription created (Spec 52 fence ✓)
  but 5 invoice items per win-back recovery (no fence on perf fee ✗)
```

Concrete numbers from the test:

```
Recovery c4ad08ab (1 row in DB, perf_fee_stripe_item_id set)  → 3 Stripe items
Recovery 32473985 (1 row in DB, perf_fee_stripe_item_id set)  → 5 Stripe items
Total Stripe invoice items: 8 (expected 2)
Test invoice: $449 paid (expected $99 + 2×$50 = $199)
```

The DB only records the *last* UPDATE's item id, but the earlier
Stripe items are still billable and **do** make it onto the customer's
invoice. The customer is silently over-charged.

### When this fires in production

`chargePerformanceFee` is only called from `chargePendingPerformanceFees`,
which itself is only called from `ensureActivation`. `ensureActivation`
has multiple production triggers — `/billing/success` page render,
`processPlatformCardCapture` webhook, `processRecovery` webhook,
`processPaymentSucceeded` webhook — and **on every first Subscribe**
two of those (the success page + the platform card-capture webhook)
fire concurrently by design. That's exactly the race window. Whether
it manifests on any given Subscribe depends on the relative timing of
the two paths' DB SELECTs and Stripe POSTs — both controlled by
Stripe and Vercel networks, not by us. Tier 1.2 happened to dodge it;
Tier 2.1's harder test caught it.

Webhook redelivery on 5xx/timeout (`processRecovery` redelivered
during a slow Stripe response) is a second, rarer trigger.

### Root cause

`chargePerformanceFee` (in `src/winback/lib/performance-fee.ts`) uses
a classic **check-then-act** pattern:

```ts
const rec = await loadRecovery(recoveryId)      // SELECT
if (rec.perfFeeStripeItemId) return alreadyCharged  // CHECK
// ... gap …
const item = await stripe.invoiceItems.create(...) // ACT (Stripe)
await db.update(recoveries).set({ perfFeeStripeItemId: item.id, ... })  // WRITE
```

Two concurrent callers complete their `SELECT` before either has
written, both see "not yet charged," both call Stripe, both write —
last writer wins on our row, but both Stripe items are real.

The subscription path (Spec 52) does NOT have this problem because it
uses a **single atomic conditional UPDATE** to claim the right to
proceed.

## Goals

- Make `chargePerformanceFee` race-safe: under N concurrent calls for
  the same recovery, exactly one Stripe invoice item is created.
- Belt + suspenders: even if the DB fence ever leaks (refactor, deploy
  race, network blip), pass `Idempotency-Key: wb-perf-${recovery.id}`
  to Stripe so duplicate POSTs deduplicate at Stripe.
- Re-pass the Tier 2.1 e2e test (`scripts/billing-test-tier2-race-fence.ts`):
  exactly 1 Stripe invoice item per seeded recovery, regardless of N.

## Non-goals

- Don't touch `refundPerformanceFee`. Refund is single-caller (only
  the `processChurn` path fires it, and that path has its own
  per-subscriber idempotency via `perf_fee_refunded_at`).
- Don't change the existing `perf_fee_stripe_item_id` /
  `perf_fee_charged_at` / `perf_fee_amount_cents` semantics.
- Don't change `ensurePlatformSubscription` (Spec 52 fence works).
- Don't audit other Stripe-create call sites in this spec — a
  separate follow-up should sweep for similar patterns.

## Schema

New column on `wb_recoveries`, matching the shape of
`wb_customers.stripe_subscription_creating_at`:

Migration `src/winback/migrations/037_perf_fee_creating_lock.sql`:

```sql
-- Spec 58 — TTL'd lock column for chargePerformanceFee's race-fence.
-- Set when a caller claims the right to create the Stripe invoice
-- item for a recovery; cleared on success (atomically with writing
-- perf_fee_stripe_item_id) or auto-expires after 30s for crash safety.
ALTER TABLE wb_recoveries
  ADD COLUMN IF NOT EXISTS perf_fee_creating_at TIMESTAMP;

COMMENT ON COLUMN wb_recoveries.perf_fee_creating_at IS
  'Spec 58 — TTL''d lock for race-safe perf-fee charging. NULL = not '
  'claimed; timestamp = a caller is mid-create. Cleared on success.';
```

Drizzle schema (`lib/schema.ts`) — add `perfFeeCreatingAt: timestamp('perf_fee_creating_at')` to the recoveries table definition, with a doc comment pointing at this spec.

## Code paths touched

| File | Change |
|---|---|
| `src/winback/migrations/037_perf_fee_creating_lock.sql` | NEW — `perf_fee_creating_at` column |
| `lib/schema.ts` | Add `perfFeeCreatingAt` field on the `recoveries` table |
| `src/winback/lib/performance-fee.ts` | Refactor `chargePerformanceFee` to use atomic claim-and-act; pass Stripe `Idempotency-Key` |
| `src/winback/__tests__/perf-fee-race.test.ts` | NEW — vitest covering: lone caller charges once; concurrent callers (Promise.all × N) yield exactly one Stripe POST; recovery already charged is a no-op; stale lock (TTL expired) can be reclaimed |
| `scripts/billing-test-tier2-race-fence.ts` | Update assertion to check the **per-recovery** Stripe-item count against the DB, not just the description match |

## Refactor (illustrative)

```ts
// Lock TTL — wide enough to cover one Stripe round-trip + DB write.
// Stripe.invoiceItems.create typically completes in 200-500ms;
// 30s is a comfortable ceiling that doesn't deadlock on normal ops
// but lets a crashed caller's lock be reclaimed.
const PERF_FEE_CREATING_LOCK_TTL_MS = 30_000

export async function chargePerformanceFee(recoveryId: string) {
  const rec = await loadRecovery(recoveryId)
  if (!rec) throw new Error(`recovery ${recoveryId} not found`)
  if (rec.recoveryType !== 'win_back') throw new Error(...)
  if (rec.perfFeeStripeItemId) {
    return { invoiceItemId: rec.perfFeeStripeItemId, ..., alreadyCharged: true }
  }
  // Pilot bypass — unchanged.
  if (await isCustomerOnPilot(rec.customerId)) { ... }

  // === Spec 58 — atomic claim ===
  const claimStaleCutoff = new Date(Date.now() - PERF_FEE_CREATING_LOCK_TTL_MS)
  const claimed = await db.update(recoveries)
    .set({ perfFeeCreatingAt: new Date() })
    .where(and(
      eq(recoveries.id, recoveryId),
      isNull(recoveries.perfFeeStripeItemId),
      or(
        isNull(recoveries.perfFeeCreatingAt),
        lt(recoveries.perfFeeCreatingAt, claimStaleCutoff),
      ),
    ))
    .returning({ id: recoveries.id })

  if (claimed.length === 0) {
    // Another caller has the lock (or just finished). Re-read once;
    // if they wrote the item id, return as alreadyCharged. Otherwise
    // log and back out — the holder will complete.
    const fresh = await loadRecovery(recoveryId)
    if (fresh?.perfFeeStripeItemId) {
      return { invoiceItemId: fresh.perfFeeStripeItemId, ..., alreadyCharged: true }
    }
    await logEvent({
      name: 'perf_fee_create_skipped_race',
      customerId: rec.customerId,
      properties: { recoveryId },
    })
    return { invoiceItemId: null, amountCents: rec.planMrrCents, alreadyCharged: false }
  }

  // === Stripe call with idempotency key (belt + suspenders) ===
  try {
    const item = await stripe.invoiceItems.create(
      { customer: ..., amount: rec.planMrrCents, ... },
      { idempotencyKey: `wb-perf-${recoveryId}` },  // 24h cache per key
    )

    await db.update(recoveries)
      .set({
        perfFeeStripeItemId: item.id,
        perfFeeAmountCents: rec.planMrrCents,
        perfFeeChargedAt: new Date(),
        perfFeeCreatingAt: null,                    // release lock
      })
      .where(eq(recoveries.id, recoveryId))

    return { invoiceItemId: item.id, ..., alreadyCharged: false }
  } catch (err) {
    // Release the lock so the next caller can retry.
    await db.update(recoveries)
      .set({ perfFeeCreatingAt: null })
      .where(eq(recoveries.id, recoveryId))
    throw err
  }
}
```

The `Idempotency-Key: wb-perf-${recoveryId}` covers the rare case
where the DB lock leaks (e.g., a refactor accidentally drops the
WHERE clause, or two callers' `claimed.length === 0` paths race in
a way that re-enters the create section). Stripe will dedupe by key
for 24 hours and return the existing item. Per-recovery keys are
natural — exactly one perf fee per recovery, ever — and recovery ids
are never reused.

## Edge cases handled

1. **Lone caller, never-charged recovery** — claim wins, Stripe POST,
   item id written. Same as today's happy path.
2. **Two concurrent callers, never-charged recovery** — one wins the
   claim, posts to Stripe, writes the id. The other gets `claimed.length === 0`,
   re-reads, sees the id, returns `alreadyCharged=true`. Net result: one
   Stripe item.
3. **Two callers race past the DB fence somehow** — both POST to Stripe
   with the same `Idempotency-Key`. Stripe returns the same item id for
   both. Last `UPDATE` wins on our row, but the value is the same. Net
   result: one Stripe item.
4. **Caller crashes after claim, before completing Stripe call** —
   the lock TTL (30s) lets the next caller reclaim. The Stripe
   idempotency key (24h) means the reclaimer's POST returns the same
   item id IF Stripe processed the original (or a new id if it didn't),
   either way we end up with exactly one item.
5. **Recovery already charged** — early-return at the top, before any
   claim or Stripe call. No change in behavior.
6. **Pilot customer** — unchanged. Pilot bypass fires before the claim.

## Backfill / cleanup

- **No production data backfill needed** — `perf_fee_creating_at`
  defaults to NULL on existing rows; that's exactly the "unclaimed"
  state the new code expects.
- **Test platform customer (`cus_UV3KU6ZWgaRgeb`) cleanup** — has 6
  orphan invoice items from the Tier 2.1 test. Manual cleanup
  via the existing `scripts/billing-test-cleanup-connect.ts` does
  not cover platform-side items; add a one-off `scripts/spec-58-cleanup-orphans.ts`
  if we want a tidy test account, or leave it (test-mode, no real money).
- **Real production impact** — none, because prod has no real customers
  yet. The bug was caught pre-launch.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — new `perf-fee-race.test.ts` cases pass alongside the existing suite
- [ ] Migration 037 applied to dev branch
- [ ] Re-run `scripts/billing-test-tier2-race-fence.ts` against dev:
  - 5 parallel `ensureActivation` calls
  - Verify **exactly 1 Stripe invoice item per seeded recovery** (the assertion that failed today should pass)
  - Verify N-1 callers logged `perf_fee_create_skipped_race` events
  - Verify exactly 1 Stripe subscription (Spec 52 fence still works)
- [ ] PR description references "Spec 58: ..." and includes the new
      Tier 2.1 output showing 1 item per recovery
- [ ] **Prod-safety**: migration is purely additive (new nullable
      column); deploy order is migration first, then code. If code
      ships before migration, the new column lookup fails — guard via
      Drizzle schema sync.

## Why this matters

The subscription race-fence (Spec 52) was the load-bearing fix for
double-creating subscriptions; this is the symmetric fix for
double-creating perf-fee invoice items. Without it, the system silently
over-bills merchants on a small percentage of first Subscribes —
exactly the wrong bug for a billing product whose value prop is
"we make billing transparent."

The fix is mechanical (matches Spec 52), small (one column, ~30 lines
of code), and has a free side-effect (idempotency keys) that hardens
the perf-fee path even further. Worth doing before launch.

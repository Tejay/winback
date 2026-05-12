# Billing regression test suite

A set of end-to-end scripts that exercise the billing-correctness paths
end-to-end against the **sandbox** Stripe account (`tkedambadi@gmail.com`)
and the **dev** Neon branch. **Never** run these against prod — they
create real Stripe customers and subscriptions in test mode (no money
moves, but they pollute the test account if not cleaned up).

## Prerequisites

1. Local dev server running: `npm run dev`
2. Ngrok forwarding to localhost: `ngrok http --url=tejay.ngrok.app 3000`
3. Sandbox webhook endpoints registered at `https://tejay.ngrok.app/api/stripe/webhook`
   (set up by `setup-sandbox-webhook-endpoints.ts`)
4. `.env.local` populated — both signing secrets, Stripe sk_test, Anthropic key, etc.

The merchant under test is hard-coded to **`tejaasvi@gmail.com`** per
CLAUDE.md → "Testing accounts."

## Reset between runs

Every script assumes the test merchant is at a **pre-first-recovery
baseline**:

```bash
npx tsx --env-file=.env.local scripts/billing-test-reset.ts
```

This nukes the merchant's recoveries, churned subscribers, events,
emails, and any leftover Stripe state. Safe to run repeatedly.

## The suite

| Script | Tier | What it verifies |
|---|---|---|
| `billing-test-tier1-real-webhook.ts` | 1.1 | Win-back recovery via real Stripe Connect webhooks → activation → Subscribe banner |
| `billing-test-tier1-payment-recovery.ts` | 1.4 | Dunning recovery (card-save) → activation → no perf fee charged |
| `billing-test-tier1-verify.ts` | 1.2 + 1.3 | Read-back of customer billing state + perf-fee + platform sub + invoice. Run after Subscribing via the dashboard. |
| `billing-test-bill-preview.ts` | end-of-cycle | Seed 10 card_save + 4 win-back recoveries, preview the next invoice ($99 + 4×$50 = $299) |
| `billing-test-tier2-race-fence.ts` | 2.1 | 5 parallel `ensureActivation` calls → exactly 1 Stripe sub, 1 perf fee per recovery (Spec 52 + 58 fences) |
| `billing-test-tier2-wrapper-race.ts` | 2.2 | Success-page vs webhook wrapper race → both converge, user always sees "active" (Spec 60) |
| `billing-test-tier2-redelivery.ts` | 2.3 | `stripe events resend` of Connect events → `processChurn` + `processRecovery` idempotent |
| `billing-test-tier3-1-cancellation.ts` | 3.1 | Merchant cancels platform sub → `processPlatformSubscriptionDeleted` clears `stripeSubscriptionId` |
| `billing-test-tier3-2-refund-within-window.ts` | 3.2 | Subscriber re-cancels within 14d → credit note created + refund issued (Spec 61) |
| `billing-test-tier3-3-refund-window-expired.ts` | 3.3 | Subscriber re-cancels at 15+ days → no refund, no credit note |
| `billing-test-tier4-pause-gates.ts` | 4 | Spec 55 split-pause (paused_at + paused_dunning_at) — independent + clearable |
| `billing-test-tier5-pilot-bypass.ts` | 5 | Spec 31 pilot bypass — active skips billing, expired resumes automatically |
| `billing-test-tier6-redelivery.ts` | 6 | Platform-side webhook redelivery idempotency + drain-cron filter idempotency |

## Diagnostics (read-only)

| Script | What it shows |
|---|---|
| `billing-test-inventory.ts` | All Winback merchants with their billing state |
| `billing-test-check-collision.ts` | Any two merchants sharing one Stripe Connect account (Spec 56 invariant) |
| `billing-test-check-webhooks.ts` | All Stripe webhook endpoints on the account |
| `billing-test-whose-connect.ts` | Which Stripe Connect account is linked to tejaasvi |
| `billing-test-check-delivery.ts` | Recent Stripe events + their pending_webhooks counters |
| `spec-62-pin-webhook-endpoints.ts` | Endpoint `api_version` status across all webhook endpoints |

## Cleanup helpers

| Script | What it does |
|---|---|
| `billing-test-reset.ts` | Reset `tejaasvi@gmail.com` to pre-first-recovery baseline |
| `billing-test-cleanup-connect.ts` | Delete `billing-test-*` customers on the Connect Stripe account |

## One-off setup tooling

| Script | Purpose |
|---|---|
| `setup-sandbox-webhook-endpoints.ts` | Replace all sandbox webhook endpoints with two correctly-configured ngrok-pointing ones (Connect + Account). Writes signing secrets to `.env.local`. Run once after Spec 62, or any time webhook endpoint config drifts. |
| `apply-migration.ts <filename>` | Generic migration runner against the DB. Used for Spec 56 (036) and Spec 58 (037). |
| `swap-whsec.ts` | Re-pin the signing secret in `.env.local` from a `stripe listen` log (legacy — only useful if you fall back to the CLI forwarder). |

## Typical regression run

```bash
# baseline
npx tsx --env-file=.env.local scripts/billing-test-reset.ts

# Tier 1
npx tsx --env-file=.env.local scripts/billing-test-tier1-real-webhook.ts
# (manually click Subscribe in /dashboard, then:)
npx tsx --env-file=.env.local scripts/billing-test-tier1-verify.ts

# Tier 2-6 (each resets internally; can run in sequence)
npx tsx --env-file=.env.local scripts/billing-test-reset.ts && \
  npx tsx --env-file=.env.local scripts/billing-test-tier2-race-fence.ts

npx tsx --env-file=.env.local scripts/billing-test-reset.ts && \
  npx tsx --env-file=.env.local scripts/billing-test-tier2-wrapper-race.ts

# ...etc for each tier
```

Each script prints `✓✓✓ Tier N verified` at the end on success, or
exits non-zero on failure with diagnostic output.

## Reference

- Test account convention: CLAUDE.md → "Testing accounts — canonical reference"
- Stripe API version pin: CLAUDE.md → "Stripe API version pin"
- Specs that drove these tests: `specs/56-*` through `specs/62-*` and earlier `specs/52-*`, `specs/55-*`, `specs/31-*`

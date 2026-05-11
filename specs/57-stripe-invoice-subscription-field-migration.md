# Spec 57 — Stripe API: `invoice.subscription` field migration

## Context

While running the Tier 1 dunning recovery test on 2026-05-11, we
discovered every `invoice.payment_succeeded` webhook for a Connect
subscription early-returns at this gate:

```ts
// app/api/stripe/webhook/route.ts:789
if (!invoice.subscription) return
```

The same gate exists in `processPaymentFailed` at line 579. Five
total references to `invoice.subscription` exist in `webhook/route.ts`
— all of them now broken.

Cause: Stripe API version `2024-09-30.acacia` (and re-confirmed in
`2026-03-25.dahlia`, our current default) **deprecated and removed**
the top-level `invoice.subscription` field. The subscription
reference moved to:

```
invoice.parent.subscription_details.subscription
```

Confirmed empirically against a live test invoice:

```
{
  id: 'in_1TW2ccDFBmovd2Ws54iDfcOe',
  subscription_top_level: '(undefined)',
  parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1TW2ccDFBmovd2WsJeldU3Ao' } }
}
```

**Impact (silent production regression):**

- A subscriber's card fails → Stripe fires `invoice.payment_failed`
  on the Connect account → `processPaymentFailed` early-returns →
  **no `wb_churned_subscribers` row gets created** →
  **no dunning email goes out** → silent data loss.
- A subscriber's card succeeds after a prior failure → Stripe fires
  `invoice.payment_succeeded` → `processPaymentSucceeded`
  early-returns → **no `wb_recoveries` row** → **no `triggerActivation`
  call** → merchant never gets billed the $99/mo platform fee that
  this recovery should have triggered.

Both end-user-invisible. The merchant dashboard shows nothing where
something should be. Discovered only because the synthetic Tier 1.4
test produced no recovery row.

This is the highest-priority pre-launch bug we've found.

## Goals

- All five `invoice.subscription` references read from the new path
  with a backward-compat fallback to the legacy field.
- A small shared helper (`getInvoiceSubscriptionId`) so the same
  pattern doesn't drift across handlers (or get bypassed by future
  copy-paste).
- Unit tests covering both API shapes (new path, legacy fallback,
  neither set).
- E2E proof via re-running the existing
  `scripts/billing-test-tier1-payment-recovery.ts` against a real
  Stripe Connect customer.

## Non-goals

- No schema change. The bug is purely about field access on the
  webhook payload — `wb_recoveries.new_stripe_sub_id` etc. all stay
  identical.
- Not pinning a specific Stripe API version on the SDK. The SDK
  already pins via the typings; we just need the runtime field
  access to match what Stripe is actually sending. Pinning is a
  larger move with its own risks (e.g. it could break other
  endpoints).
- No new tests for `processPaymentFailed`'s dunning state machine
  beyond what's needed to verify the field-access fix — that
  behaviour is already covered by other tests.

## Code paths touched

| File | Lines | Change |
|---|---|---|
| `src/winback/lib/stripe.ts` | NEW export | Add `getInvoiceSubscriptionId(invoice: unknown): string \| null` helper that reads `invoice.parent.subscription_details.subscription` first, falls back to legacy `invoice.subscription` (string or object), returns `null` if neither |
| `app/api/stripe/webhook/route.ts` | 579 | `if (!invoice.subscription) return` → `if (!getInvoiceSubscriptionId(invoice)) return` |
| `app/api/stripe/webhook/route.ts` | 725-727 | The `typeof invoice.subscription === 'string' ? invoice.subscription : (...).id ?? ''` cascade → `const subscriptionId = getInvoiceSubscriptionId(invoice) ?? ''` |
| `app/api/stripe/webhook/route.ts` | 789 | same as 579 |
| `app/api/stripe/webhook/route.ts` | 869 | `newStripeSubId: typeof invoice.subscription === 'string' ? invoice.subscription : null` → `newStripeSubId: getInvoiceSubscriptionId(invoice)` |
| `src/winback/__tests__/invoice-subscription-id.test.ts` | NEW | 4 cases: (a) new shape with `parent.subscription_details.subscription` → returns id, (b) legacy shape with `invoice.subscription` as string → returns id, (c) legacy with `invoice.subscription` as full Subscription object → returns id, (d) both missing → returns null |

## Helper implementation (illustrative)

```ts
// src/winback/lib/stripe.ts
export function getInvoiceSubscriptionId(invoice: unknown): string | null {
  if (!invoice || typeof invoice !== 'object') return null
  const inv = invoice as Record<string, unknown>

  // API ≥ 2024-09-30: invoice.parent.subscription_details.subscription
  const parent = inv.parent as Record<string, unknown> | undefined
  const subDetails = parent?.subscription_details as Record<string, unknown> | undefined
  const fromParent = subDetails?.subscription
  if (typeof fromParent === 'string') return fromParent
  if (fromParent && typeof fromParent === 'object') {
    const id = (fromParent as Record<string, unknown>).id
    if (typeof id === 'string') return id
  }

  // Legacy: top-level invoice.subscription (pre-2024-09-30)
  const legacy = inv.subscription
  if (typeof legacy === 'string') return legacy
  if (legacy && typeof legacy === 'object') {
    const id = (legacy as Record<string, unknown>).id
    if (typeof id === 'string') return id
  }

  return null
}
```

## Edge cases handled

1. **New API shape (current default).** Reads from `parent.subscription_details.subscription`.
2. **Legacy API shape.** Falls back to the deprecated top-level
   `invoice.subscription`. Necessary because Stripe still includes
   the legacy field on some replayed/older events, and because the
   account's `api_version` (set per-webhook-endpoint, currently
   `(default)`) may move under our feet without us realising.
3. **Either field as a string OR an expanded Subscription object.**
   Both shapes seen in production — the previous code already
   handled this duality with a `typeof === 'string'` cascade; the
   helper preserves that.
4. **One-time invoices.** Both fields are absent → helper returns
   `null` → early-return in caller fires correctly (this is the
   intended behaviour — Winback only cares about subscription
   invoices).
5. **Replayed events from before the upgrade.** Backwards-compatible
   because the helper checks both shapes.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — including the new
      `invoice-subscription-id.test.ts` cases (4 assertions above)
      plus existing webhook tests still green
- [ ] **E2E manual:**
  - Reset dev DB (`scripts/billing-test-reset.ts`)
  - Run `scripts/billing-test-tier1-payment-recovery.ts`
  - Expect: `wb_recoveries` row appears with
    `recoveryType='card_save'`, `attributionType='strong'`,
    `perfFeeStripeItemId=null`; `customers.activatedAt` populated
- [ ] **Prod-safety:** the helper accepts both API shapes, so
      deploying the code change does not require a Stripe API
      version pin or a webhook endpoint reconfig. No prod data
      migration needed.

## Out of scope

- Stripe API version pinning (separate discussion — bigger blast
  radius)
- Other webhook fields that may have been re-shaped by the same
  Stripe API change (e.g., `subscription.latest_invoice`,
  `subscription.current_period_end` — none currently flagged as
  broken, but worth a follow-up audit)
- Adding similar helpers for non-invoice webhook payloads (not
  affected by this Stripe change)

## Why this is urgent

The dunning recovery path is silently broken in production today.
Every payment-recovery scenario — a subscriber's card fails, our
system fails to record it, the merchant never sees the dunning email,
the merchant never gets billed when Stripe's auto-retry succeeds —
fails closed (no errors, no logs at the merchant level). With launch
pending, every day this isn't fixed is a day we'd be missing real
payment-recovery revenue and shipping a broken dunning experience
to the first paying merchant.

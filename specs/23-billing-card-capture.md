# Spec 23 — Phase 9.1: Stripe platform card capture

**Phase:** Next up (April 2026)
**Depends on:** Spec 18 (attribution), existing `billing.ts` / `obligations.ts`
**Unblocks:** Phase 9.2 (monthly invoice cron), Phase 9.3 (dunning)

---

## Summary

Wires the "Add payment method" button in `/settings` to a real Stripe
flow that captures a card on **Winback's platform Stripe account**
(distinct from the customer's Connected account used for Stripe webhooks).

**Scope**: Add + Update only. No Remove (handled by "Delete workspace"
flow). No invoicing (that's 9.2). No dunning (that's 9.3).

---

## Context

- Billing math already built: `src/winback/lib/billing.ts`,
  `src/winback/lib/obligations.ts`. Calculates 15% × 12 months × strong
  recoveries.
- Settings page already has a **non-functional** "Add payment method"
  button (`app/settings/page.tsx` line ~135).
- `wb_settlement_requests` exists for one-time deletion settlements, not
  for recurring monthly billing.
- Existing webhook (`app/api/stripe/webhook/route.ts`) handles Connect
  events; drops platform events silently.

---

## Design

### Flow

```
"Add payment method" click
  → POST /api/billing/setup-intent
  → getOrCreatePlatformCustomer(wbCustomerId)  // lazy creation
  → stripe.checkout.sessions.create({ mode: 'setup', customer, metadata })
  → { url } returned, client redirects
User completes Checkout on Stripe
  → checkout.session.completed webhook fires (platform event)
  → processPlatformCardCapture():
      - retrieve SetupIntent from session
      - extract payment_method ID
      - detach previous PM (if any — Update flow)
      - set new PM as customer's default
  → Stripe redirects user to /settings?billing=success
/settings server-renders
  → reads wb_customers.stripe_platform_customer_id
  → fetches customer from Stripe (expand default_payment_method)
  → renders "Visa •••• 4242 · exp 12/2030 · [Update]"
```

### Schema

```sql
-- 015_platform_billing.sql
ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS stripe_platform_customer_id TEXT;
```

No PM caching — fetched from Stripe at render time. Always accurate.

### Metadata-based webhook dispatch

Both reactivation checkouts (existing) and platform card captures (new)
fire `checkout.session.completed`. Differentiate by `session.metadata`:

| Metadata | Handler |
|----------|---------|
| `flow: 'platform_card_capture'` | `processPlatformCardCapture` (new) |
| `winback_subscriber_id: ...` | `processCheckoutRecovery` (existing) |

### Update flow (no separate endpoint needed)

Clicking "Update" reuses `/api/billing/setup-intent`. New PM attached,
set as default. Previous PM is detached in the webhook handler
(`paymentMethods.detach`) so old cards don't pile up.

### Failure modes

- **Setup cancelled**: Stripe redirects to `?billing=cancelled`. Settings
  renders a neutral banner. DB unchanged.
- **Webhook processing failure**: session is captured in Stripe regardless.
  We log the error. Settings page reads from Stripe on next load — card
  will appear correctly even if webhook processing lagged.
- **Stripe API down during Settings render**: `try/catch` around the
  retrieve call. We render "Couldn't load card details" and a retry button.

---

## Files

### New
- `src/winback/migrations/015_platform_billing.sql`
- `src/winback/lib/platform-stripe.ts` — `getPlatformStripe()` helper
- `src/winback/lib/platform-billing.ts` — `getOrCreatePlatformCustomer()`, `fetchPlatformPaymentMethod()`
- `app/api/billing/setup-intent/route.ts` — POST handler
- `app/settings/payment-method-section.tsx` — client component
- `src/winback/__tests__/platform-billing.test.ts` — unit tests

### Modified
- `lib/schema.ts` — add `stripePlatformCustomerId`
- `app/api/stripe/webhook/route.ts` — metadata-based dispatch + `processPlatformCardCapture`
- `app/settings/page.tsx` — fetch PM at render, pass to client component

### Reused
- `auth()` from `lib/auth.ts`
- `logEvent()` from `src/winback/lib/events.ts`

### Env vars
None new. `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` already set.

---

## Stripe dashboard (manual, one-time)

In the webhook settings, ensure the endpoint `/api/stripe/webhook` is
subscribed to `checkout.session.completed` on the **platform** account
(in addition to the existing Connect events). Same signing secret works
for both. Test locally with:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

---

## Events

New `wb_events`:
- `billing_setup_started` — `{ stripeSessionId }`
- `billing_setup_cancelled` — when user returns to `?billing=cancelled`
- `billing_card_captured` — `{ paymentMethodId, stripeSessionId, wasUpdate }`

---

## Verification

### Unit
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — new tests for `getOrCreatePlatformCustomer` + webhook metadata dispatch
- [ ] Migration 015 applied to Neon

### Manual (Stripe test mode)
- [ ] Fresh customer: `/settings` shows "Add payment method"; click → redirects to Checkout
- [ ] Card `4242 4242 4242 4242` → Save → returns to `/settings?billing=success`
- [ ] Card renders as "Visa •••• 4242 · exp ..."
- [ ] `wb_customers.stripe_platform_customer_id` populated; Stripe dashboard shows customer with default PM
- [ ] `wb_events` has `billing_setup_started` + `billing_card_captured`

### Update flow
- [ ] Click "Update" → Checkout → new card `5555...4444` → returns
- [ ] Card now "Mastercard •••• 4444"; old PM detached in Stripe
- [ ] `billing_card_captured` event has `wasUpdate: true`

### Cancel flow
- [ ] Click "Add" → cancel on Checkout → `/settings?billing=cancelled`
- [ ] Cancelled banner rendered; DB unchanged

### Mobile
- [ ] At 375px: Settings renders cleanly, card row and Update button stack

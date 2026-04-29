# Spec 35 — Stripe Checkout Session for update-payment (replaces Billing Portal redirect)

**Phase:** Pre-launch hardening
**Depends on:** Spec 09 (`/api/update-payment` route + dunning email link), Spec 33 (multi-touch dunning emails)
**Estimated time:** ~half a day

---

## Context

Today, when a customer clicks the *"Update payment"* link in any of our
dunning emails (T1 / T2 / T3 from Spec 33), they hit
`/api/update-payment/[subscriberId]` which redirects to a Stripe **Billing
Portal** session. The portal is fine but **structurally limited**: it
renders a card-only "Add payment method" form regardless of what payment
methods the merchant has enabled in their account.

We verified this empirically:

- The merchant's default Payment Method Configuration (`pmc_…`) has
  Apple Pay, Google Pay, Link, and card all enabled
- The Billing Portal's "Add payment method" form shows **only card** —
  no wallets, no PayPal, no ACH, regardless of PMC
- Stripe's Billing Portal product manages payment methods through its
  own whitelist (`features.payment_method_update`), independent of the
  merchant's main PMC, and historically optimised for "manage existing
  subscription" rather than "convert at high intent"

We also tested a Stripe **Checkout Session** in `mode: 'payment'` against
the same merchant + customer:

- Apple Pay rendered prominently as a tap-button at the top
- Link rendered alongside (Stripe wallet)
- Card form below with all card brand badges
- "Save my information" baked in
- Mobile UX excellent

Same merchant. Same PMC. Same Stripe.js engine. Different product surface,
dramatically better wallet visibility because Checkout uses the merchant's
full PMC.

This spec swaps the Billing Portal redirect for a Checkout Session
redirect — `mode: 'setup'` so we collect the new payment method without
charging anything during the setup step, then retry the actual failed
invoice server-side once the session completes.

---

## Goals

| # | Goal | Mechanism |
|---|------|-----------|
| 1 | Surface every payment method the merchant has enabled in their PMC (wallets, BNPL, ACH, etc.), not just card | `stripe.checkout.sessions.create({ mode: 'setup', customer })` automatically uses the merchant's default PMC |
| 2 | Match the conversion lift a custom Payment Element page would deliver, without us building or maintaining one | Stripe Checkout = same Payment Element underneath, just hosted by Stripe instead of by us |
| 3 | Time-to-recovery falls — failed invoice retries the moment the new PM is attached, not on Stripe's next scheduled retry | New webhook handler for `checkout.session.completed` calls `stripe.invoices.pay()` on open failed invoices |
| 4 | All existing attribution + recovery detection keeps working unchanged | `billingPortalClickedAt` still set on click; existing `invoice.payment_succeeded` recovery flow fires after the manual `pay()` |

---

## Non-goals

- **Custom-branded Winback-hosted Payment Element page.** Initially proposed
  as the Spec 35 design; explicitly rejected after empirically testing
  Stripe Checkout. The conversion lift is the wallet visibility, not the
  domain — Checkout delivers wallet visibility for free with no
  build/maintenance cost.
- **A/B testing the update-payment page layout.** Premature at pilot
  scale; you'd need 100s of conversions to A/B meaningfully.
- **Per-merchant Checkout branding customisation.** Stripe Checkout has
  dashboard-level branding settings the merchant controls themselves
  (logo, colour, business name); we don't need to layer anything.
- **Removing the existing Billing Portal session creation code.** Stripe's
  Billing Portal is also useful for *managing* an existing subscription
  (cancel, view invoices, etc.). We just stop using it for the
  *update-payment* link specifically. The portal stays available if any
  other Winback flow wants it later.

---

## Detection (single SQL truth)

No schema changes — the test is **visual**:

1. Customer clicks an "Update payment" link in any T1/T2/T3 email
2. They see Stripe Checkout, not Billing Portal
3. Apple Pay button visible at top (on Safari/iOS) or Google Pay (on Chrome)
4. Link button visible (always)

Behaviourally:

```sql
-- After the customer completes Checkout, the existing recovery flow
-- runs automatically. Confirm via:
SELECT name, properties, created_at
FROM   wb_events
WHERE  name IN ('link_clicked', 'subscriber_recovered')
   AND created_at > now() - interval '1 hour'
ORDER  BY created_at DESC;

-- Recovery row exists with attribution = 'strong' (clicked our link):
SELECT r.id, r.attribution_type, r.recovery_type
FROM   wb_recoveries r
JOIN   wb_churned_subscribers s ON s.id = r.subscriber_id
WHERE  s.cancellation_reason = 'Payment failed'
ORDER  BY r.recovered_at DESC LIMIT 5;
```

---

## Subscription compatibility (important)

The dunning use case requires a payment method that can be **saved and
re-charged off-session** — the customer's failed invoice will retry
automatically once the new PM is attached.

`mode: 'setup'` creates a SetupIntent with `usage: 'off_session'` by
default, and **Stripe automatically filters the payment-method picker
to only show methods that support off-session recurring billing**. This
filtering is structural, not configurable — we don't need to allowlist
anything. Methods that don't fit are dropped from the form.

| Method | Surfaces in setup-mode Checkout? | Works for subs? | Notes |
|---|---|---|---|
| Card | ✅ Always | ✅ | Canonical recurring path |
| Apple Pay | ✅ Safari + Chrome on macOS/iOS only | ✅ | Tokenises a real card; resulting PM is `type: 'card'`. UA-gated by Stripe — Safari sees it, Chrome on Android does not. |
| Google Pay | ✅ Chrome on Android/ChromeOS/Windows/desktop only | ✅ | Same as Apple Pay. UA-gated — Safari users will NOT see this button (Apple Pay shows instead). |
| Link | ✅ Always | ✅ | Stripe's own wallet (not OS-tied), stores card or bank. Always renders. |
| ACH / SEPA / BACS | ✅ if PMC enables | ✅ | Bank-debit, off-session standard |
| **PayPal** | ⚠️ Conditional | ⚠️ Conditional | Needs merchant to authorise PayPal *billing agreements* — Stripe handles this in the setup flow when both are configured. For our merchant's current PMC, PayPal is off, so moot. |
| **Klarna / Afterpay (BNPL)** | ❌ Hidden | ❌ | BNPL is one-off-purchase by design — Stripe filters them out of setup-mode automatically |
| Cash App Pay | ⚠️ Conditional | ⚠️ | Off-session support is limited; Stripe surfaces only when both Stripe + the merchant have it set up correctly |

**Operational implication:** for Spec 35 v1 we don't have to do anything
special. Whatever Stripe surfaces in the Checkout page will be
subscription-compatible. The card-tokenised wallets (Apple Pay /
Google Pay / Link) work identically to a saved card for subsequent
charges — the customer doesn't see "Apple Pay" again on their next
invoice, they see "Card ·· 4242", because the underlying PM is just a
card.

**Merchant onboarding implication: zero.** Every Stripe Connect account
gets a default Payment Method Configuration that already enables Card +
Link + Apple Pay + Google Pay out of the box. Apple Pay domain
verification is handled by Stripe (the page lives on
`checkout.stripe.com`, not our domain), and Google Pay needs no setup at
all. So a founder who completes Stripe OAuth onboarding gets the full
wallet set surfaced in the customer's Checkout page automatically —
nothing for them to flip on, no extra screen in our onboarding flow.

The methods that *would* require explicit merchant action (PayPal,
Klarna, ACH/SEPA, Cash App Pay) don't apply to our v1: BNPL is hidden
in setup-mode anyway, and our pilot merchants haven't enabled the
others. If a merchant later turns one on in their dashboard, it'll
surface in our Checkout page automatically — no Winback code change
required.

**Failure-mode caveat:** Apple Pay backed by *the same expired card*
that just failed = same decline. Stripe Apple Pay tokenises the user's
actual card. Most users have multiple cards in their Wallet so this is
rare, but our existing `payment_method_at_failure` attribution check
handles it (we only credit weak/strong recovery if the PM actually
changed).

---

## Code changes

### 1. `/api/update-payment/[subscriberId]/route.ts`

Replace the Billing Portal `sessions.create` with a Checkout Session in
setup mode:

```ts
// Before (Billing Portal — to be removed for the update-payment flow):
const session = await stripe.billingPortal.sessions.create({
  customer: subscriber.stripeCustomerId,
  return_url: `${baseUrl}/welcome-back?recovered=true`,
})

// After (Checkout Session in setup mode — surfaces full PMC):
//
// Stripe requires `currency` in setup mode (drives method filtering —
// e.g. SEPA for EUR, BACS for GBP, ACH for USD). We pull it from the
// subscription we're trying to recover so the picker matches the
// currency that'll actually be charged. If the subscription fetch
// fails (deleted upstream, transient API blip), fall back to 'usd'.
let currency = 'usd'
if (subscriber.stripeSubscriptionId) {
  try {
    const sub = await stripe.subscriptions.retrieve(subscriber.stripeSubscriptionId)
    if (sub.currency) currency = sub.currency
  } catch (err) {
    console.warn('[update-payment] subscription retrieve failed, defaulting to usd:', err)
  }
}

const session = await stripe.checkout.sessions.create({
  mode:        'setup',
  currency,
  customer:    subscriber.stripeCustomerId,
  success_url: `${baseUrl}/welcome-back?recovered=true&session_id={CHECKOUT_SESSION_ID}`,
  cancel_url:  `${baseUrl}/welcome-back?recovered=false`,
  // Track which subscriber this is so the webhook can correlate.
  metadata: {
    winback_subscriber_id: subscriberId,
    winback_customer_id:   subscriber.customerId,
    winback_flow:          'dunning_update_payment',
  },
  // Setup mode collects a payment method without charging. Stripe uses
  // the merchant's default PMC + the currency above to decide which
  // methods to show.
})
```

**Keep unchanged:**
- The `billingPortalClickedAt` write (existing attribution signal). Rename
  to `paymentUpdateClickedAt` is tempting but unnecessary churn — keep
  the column name, it just means "customer clicked the update-payment
  link" regardless of which Stripe product is on the other side.
- The `link_clicked` `wb_events` row. Update `linkType` from
  `'billing_portal'` to `'checkout_setup'` so we can tell the two cohorts
  apart in analytics.

### 2. Webhook handler — `checkout.session.completed`

New branch in [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts).
This event fires on the **connected account** (because we created the
Checkout Session via the merchant's access token).

```ts
if (event.type === 'checkout.session.completed') {
  if (event.account) {
    const session = event.data.object as Stripe.Checkout.Session
    if (session.metadata?.winback_flow === 'dunning_update_payment') {
      await processDunningPaymentUpdate(event)
    }
    // existing branch for win-back checkout (Spec 23) stays
  }
  // platform-side branches stay
}
```

`processDunningPaymentUpdate(event)` does:

1. Resolve the subscriber row by `metadata.winback_subscriber_id`
2. Resolve the customer + decrypt access token (existing pattern)
3. Read the Setup Intent: `stripe.setupIntents.retrieve(session.setup_intent)`
4. Attach the payment method to the customer as default:
   ```ts
   await stripe.customers.update(stripeCustomerId, {
     invoice_settings: { default_payment_method: setupIntent.payment_method },
   })
   ```
5. Find any **open** failed invoice tied to this subscriber's subscription:
   ```ts
   const invoices = await stripe.invoices.list({
     customer:     stripeCustomerId,
     subscription: subscriber.stripeSubscriptionId,
     status:       'open',
     limit: 5,
   })
   ```
6. For each open invoice: `await stripe.invoices.pay(inv.id)` — retry now,
   don't wait for Stripe's next scheduled retry. Shortens time-to-recovery
   from days to seconds.
7. Stripe fires `invoice.payment_succeeded` on success → existing
   `processPaymentSucceeded` recovery flow runs → recovery row created
   with `attributionType: 'strong'` (because `billingPortalClickedAt` is
   set), `recoveryType: 'card_save'`, dunning state cleared.
8. Log `dunning_payment_method_updated` event with the new PM ID and
   the count of invoices retried.

If `stripe.invoices.pay()` fails (genuine decline even with the new card):
no error to the user — the existing dunning sequence continues. Stripe
will retry on its own schedule. T2/T3 still fire if relevant.

### 3. `wb_emails_sent` types — no change

Email types and idempotency unchanged. The Checkout Session URL replaces
the Billing Portal URL inside the same email body, but the email itself
is identical.

---

## Tests

Pattern: `vi.hoisted` mocks of Stripe + `@/lib/db`, mirrors existing
webhook tests.

`src/winback/__tests__/update-payment-route.test.ts` (new, ~5 tests):
- Creates Checkout Session with `mode: 'setup'` + correct customer
- Records `billingPortalClickedAt` before redirect (existing behaviour)
- Logs `link_clicked` event with `linkType: 'checkout_setup'`
- Returns 302 to `session.url`
- Bails to `/welcome-back?recovered=false` if subscriber not found

`src/winback/__tests__/checkout-session-completed.test.ts` (new, ~6 tests):
- Skips when `metadata.winback_flow` is not `'dunning_update_payment'`
- Retrieves the SetupIntent + extracts the `payment_method` ID
- Attaches PM as customer's `invoice_settings.default_payment_method`
- Lists open invoices for the subscription
- Calls `stripe.invoices.pay` on each
- Logs `dunning_payment_method_updated` event

Existing tests for `processPaymentSucceeded` remain unchanged — the
recovery flow downstream of the manual `invoices.pay` is identical to
the case where Stripe retried on its own schedule.

---

## Verification

```bash
git checkout -b feat/spec-35-checkout-session
# (after writes)
npx tsc --noEmit
npx vitest run

# End-to-end manual:
# 1. Re-run scripts/dunning-e2e.ts to seed a "Payment failed" subscriber
#    + send a T1 (use the same recipient as before)
# 2. Click "Update payment" link in the inbox
# 3. EXPECTED: see Stripe Checkout page (not Billing Portal!) with:
#    - Apple Pay button at top (on Safari/iOS Chrome)
#    - Link button
#    - Card form with all brand badges
#    - "Save my information" checkbox
# 4. Complete the form with test card 4242 4242 4242 4242
# 5. EXPECTED:
#    - Land on /welcome-back?recovered=true
#    - dev log shows 'checkout.session.completed' webhook fire
#    - dev log shows 'dunning_payment_method_updated' event
#    - dev log shows 'invoice.payment_succeeded' fire
#    - dev log shows 'subscriber_recovered' event
#    - psql: wb_recoveries has new row, attribution_type='strong',
#            recovery_type='card_save'
#    - psql: wb_churned_subscribers row has status='recovered',
#            dunning_state='recovered_during_dunning'

# PR opens with explicit callout that we no longer use Billing Portal
# for the update-payment flow, but the merchant's portal config is
# untouched.
```

---

## Edge cases handled

1. **Customer abandons Checkout Session.** No `checkout.session.completed`
   fires, no PM attached, no invoice retry. Dunning continues as if the
   click never happened. T2/T3 still fire on schedule. Correct.
2. **Customer completes Checkout but Stripe declines the manual invoice
   pay** (genuine bad card despite the customer's effort). Existing
   dunning sequence continues. Stripe will retry on its scheduled cadence.
3. **Customer has multiple open failed invoices.** We retry all of them
   in the webhook handler, oldest first. If any succeed, the existing
   `processPaymentSucceeded` flow handles per-invoice attribution.
4. **Customer enters Apple Pay backed by the same expired card** —
   Stripe Apple Pay tokenises the actual card, so this would still fail.
   But Apple Pay is much more often a *different* card (the one the
   user has set as their iPhone default), so this is rare. The
   `payment_method_at_failure` comparison in our existing recovery
   attribution still works correctly.
5. **Apple Pay domain registration.** Stripe Checkout pre-registers
   `checkout.stripe.com` for Apple Pay. We don't need to register
   `winbackflow.co` (that would only matter for a custom Payment Element
   page).
6. **Setup-mode pricing.** Stripe charges nothing for `mode: 'setup'`
   itself; the only charges that happen are when we manually `invoices.pay()`
   the open invoice afterwards.
7. **Stripe Connect Standard accounts.** Confirmed empirically — the
   sandbox merchant account has 0 active capabilities and Checkout
   still works in test mode. Production Standard accounts will have
   strictly more capabilities active, not fewer.

---

## Out of scope (future)

- **Spec 34** — decline-code-aware action coaching in the email bodies
  (T1/T2/T3). Independent of the page-after-the-click — see
  [specs/34-decline-code-copy.md](34-decline-code-copy.md).
- Custom Payment Element page on `winbackflow.co` (explicitly rejected
  in favour of Checkout — see context).
- Replacing Billing Portal usage in *other* flows (cancel, view invoices,
  etc.). Out of scope; Stripe Billing Portal is fine for those use cases.
- Pre-emptive `invoice.upcoming` "card expires soon" emails (separate spec).
- SMS update-payment links for high-MRR subscribers (separate spec).

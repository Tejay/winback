# Spec 52 — Subscribe synchronous activation + dedicated success page

## Context

Spec 51 introduced the Subscribe flow: a paused merchant (`activatedAt
&& !stripeSubscriptionId`) clicks **Subscribe via Stripe**, lands on
Stripe Checkout in `mode='setup'`, enters a card, and is returned to
the app. The expected outcome is "card on file + Stripe Subscription
created + dashboard banner clears".

Testing in dev surfaced a real reliability gap: **the Stripe
Subscription is only created by the asynchronous webhook handler**
(`processPlatformCardCapture` → `triggerActivation` →
`ensureActivation`). If the webhook is delayed, missed, or fails (test
mode without `stripe listen`, wrong CLI project, an outage between
Stripe and the app), the merchant ends up in this broken state:

- Card attached to the Stripe customer ✓
- `customers.activatedAt` set ✓
- `customers.stripeSubscriptionId` still NULL ✗
- Banner stays up forever, even though the merchant has done their part

Concrete example observed today (2026-05-11): tejaasvi@gmail.com's
platform customer `cus_UN0ClcHh7BriCs` had 8 cards attached and a
default PM set, `activatedAt` set since 2026-04-30, yet
`stripeSubscriptionId` was NULL. The banner persisted across reloads.
Running `ensureActivation` manually from a script created the
subscription (`sub_1TVh3rAt1bwzP4uUETRvySxD`) and the banner cleared on
next load — confirming the logic itself is correct; what's missing is
a reliable trigger that isn't a single asynchronous webhook.

Secondary issue: the Stripe Checkout `success_url` is
`/settings?billing=success`. The merchant clicked Subscribe from the
**dashboard**, where the banner lives, but lands on Settings — jarring,
and Settings has no acknowledgement that anything just happened. The
user expects a brief "you're subscribed" confirmation and an obvious
way back to the dashboard they came from.

## Goals

1. The Stripe Subscription is created **before** the user-visible page
   acknowledges success. No race between rendering a confirmation and
   the subscription actually existing.
2. The redirect lands on a page whose entire job is to confirm
   "subscribed" and route the merchant back to the dashboard.
3. Existing webhook handler stays in place unchanged — it remains a
   redundant second trigger for cases where the redirect never
   completes (tab closed, network drop, browser crash between Stripe
   and the app).
4. Both trigger paths (redirect + webhook) are idempotent and converge
   on the same end state. Whichever fires first wins; the other
   no-ops.

## Non-goals

- Changing the Checkout mode (stays `setup`, not `subscription`). The
  setup-mode pattern is shared with future "save card without billing"
  flows (e.g., dunning add-card by the merchant's customer). Switching
  to `mode=subscription` here would fork the code path for no benefit.
- Changing `ensureActivation` itself. It's already idempotent and
  converging — this spec adds another caller, doesn't reshape what's
  called.
- Skipping Checkout for already-carded merchants. The "PM present, sub
  missing" state should not occur in normal operation once this spec
  ships; the rare residual case (e.g., re-subscribe after cancellation)
  goes through Checkout fine — Stripe lets the user add a card without
  charging.
- Touching the dashboard banner logic. Banner visibility stays purely
  derived from `activatedAt && !stripeSubscriptionId`. Once the
  synchronous activation runs, the banner is gone on the next
  dashboard load with no client-side state involved.
- Toast / inline-confirmation on the dashboard. We use a dedicated
  page instead so the merchant has a clear visual moment of "this
  worked" before going back to work.

## Design

### Two independent triggers for the same idempotent action

```
┌──────────────────────────┐       ┌────────────────────────────┐
│ User-visible redirect    │       │ Stripe server-side webhook │
│ path (new):              │       │ path (existing, unchanged):│
│                          │       │                            │
│ Stripe Checkout success  │       │ checkout.session.completed │
│   └─ success_url:        │       │   └─ POST /api/stripe/     │
│      /billing/success    │       │      webhook               │
│   └─ server component    │       │   └─ processPlatform       │
│      runs:               │       │      CardCapture →         │
│        setDefaultPM      │       │        setDefaultPM        │
│        ensureActivation  │       │        triggerActivation → │
│                          │       │          ensureActivation  │
└──────────────────────────┘       └────────────────────────────┘
                 ↓                            ↓
                 └──────── same end state ────┘
                  (idempotent — second caller no-ops)
```

Whichever path completes first creates the subscription. The other
runs but `ensureActivation` reads DB state, sees the subscription
already exists, and returns `active` without re-creating anything.

### Change 1 — Checkout success_url moves to `/billing/success`

`app/api/billing/setup-intent/route.ts`:

```diff
-      success_url: `${baseUrl}/settings?billing=success`,
+      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
       cancel_url: `${baseUrl}/settings?billing=cancelled`,
```

`{CHECKOUT_SESSION_ID}` is Stripe's templated placeholder — replaced
server-side by the actual session id before the redirect lands on us.

### Change 2 — New page `app/billing/success/page.tsx`

A server component. Workflow:

1. Read `session_id` from `searchParams`. If missing or malformed →
   render a "Looks like something went wrong" fallback with a "Back to
   dashboard" link. (No throw — we never want this page to 500.)
2. Auth-gate via `getServerSession`; redirect to `/login` if no
   session.
3. Look up the wb_customer for `session.user.id`. If not found → same
   graceful fallback.
4. **Synchronous activation block — all wrapped in a try/catch:**
   - `stripe.checkout.sessions.retrieve(session_id, { expand: ['setup_intent'] })`
   - Verify `session.metadata?.winback_customer_id` matches the
     authenticated user's wb_customer id. (Defence in depth — protects
     against a leaked / brute-forced session_id from another customer.)
   - Extract `payment_method` from the SetupIntent; call
     `setDefaultPaymentMethod(platformCustomerId, paymentMethodId)`.
   - Call `ensureActivation(wbCustomerId)` and read the result.
5. Render based on outcome:
   - `active` → big green checkmark + "You're subscribed." + "We'll
     bill $99/mo + 1× MRR per recovery. 14-day refund window on each
     win-back." + one primary button **"Back to dashboard"**.
   - `awaiting_card` (shouldn't happen here — we just attached one,
     but defensive) → "Almost there — your card just landed, we're
     finalising your subscription. Refresh in a moment." + "Back to
     dashboard" link.
   - `no_op` (shouldn't happen — they had to be activated to see the
     Subscribe button) → same "Almost there" copy + link.
   - `pilot` → "You're on the pilot programme — no billing for now."
     + "Back to dashboard". (Pilot merchants don't see the banner so
     they'd never reach this page, but render safely.)
   - try/catch error → "Almost there — we're finalising your
     subscription in the background. Refresh in a moment." + "Back to
     dashboard". The webhook will catch up.

Visual: matches existing auth/onboarding pages — `min-h-screen
bg-[#f5f5f5]`, logo top-left, single white card `max-w-md mx-auto
rounded-2xl shadow-sm border border-slate-100 p-8`. Centered checkmark
icon (lucide `CheckCircle2`, `text-green-500 h-12 w-12`), title
"You're subscribed.", subtitle (one short paragraph), single primary
button.

### Change 3 — No change to webhook handler

`processPlatformCardCapture` in `app/api/stripe/webhook/route.ts`
already does the exact same two operations (`setDefaultPaymentMethod`
+ `triggerActivation`) and logs `billing_card_captured`. Leave it
alone. Both paths fire on a normal successful flow; the second one is
a no-op via `ensureActivation`'s idempotency.

`logEvent` will record `billing_card_captured` twice in some cases —
once from `/billing/success` server component, once from the webhook.
That's fine: the events table records *what happened*, and "the
card-captured handler ran twice converging on the same state" is
truthfully what happened. We can deduplicate at the read layer later
if it bothers analytics, but it's not a correctness issue today.

(Actually — to keep the events table clean, the new
`/billing/success` page does NOT call `logEvent('billing_card_captured')`.
Only the webhook does. The page only relies on the side-effect of
`setDefaultPaymentMethod` + `ensureActivation`. This keeps a single
canonical "card captured" event per Checkout completion.)

## Schema

No schema changes.

## Code paths touched

| File | Change |
|---|---|
| `app/api/billing/setup-intent/route.ts` | Change `success_url` |
| `app/billing/success/page.tsx` | **new** server component |
| `app/api/stripe/webhook/route.ts` | no change |
| `src/winback/lib/platform-billing.ts` | no change |
| `src/winback/lib/activation.ts` | no change |

## Edge cases handled

- **`session_id` missing from query string** → fallback page, no crash
- **`session_id` belongs to a different customer** → fallback page, no
  cross-customer activation. (Stripe's session_id is not secret; the
  metadata-match check prevents abuse.)
- **Stripe API throws during retrieve / setDefaultPM / ensureActivation**
  → "Almost there" page. Webhook will catch up. Logged via existing
  Stripe error path in `ensureActivation`.
- **Webhook fires first** (e.g., user's connection is fast Stripe-side
  but slow on the return trip) → activation already done by the time
  the page loads. `ensureActivation` returns `active` with
  `subscriptionCreated: false`. Page renders the success state.
- **User refreshes `/billing/success`** → `ensureActivation` no-ops,
  page re-renders success. No double-billing, no duplicate subscription.
- **User bookmarks `/billing/success?session_id=...` and revisits a
  week later** → same as refresh; idempotent. The Stripe session is
  long-expired but `setDefaultPaymentMethod` and `ensureActivation`
  read from current DB / Stripe customer state, not the session.
- **`ensureActivation` returns `no_op` (no recoveries yet)** → only
  possible if the merchant somehow reached Checkout without a delivered
  recovery; the page renders "Almost there" defensively. In practice
  the Subscribe button isn't rendered for such customers.
- **Pilot merchant** → `ensureActivation` returns `pilot`, page
  renders a pilot-specific copy variant. Won't happen via the banner
  path (pilot customers don't see Subscribe) but renders safely if
  reached.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green
- [ ] **End-to-end manual test on local dev with `stripe listen`
      running on `wingback sandbox`:**
  - [ ] Pick a paused merchant (`activatedAt IS NOT NULL AND
        stripeSubscriptionId IS NULL`), confirm banner shows
  - [ ] Click Subscribe via Stripe → Stripe Checkout opens
  - [ ] Add card 4242 4242 4242 4242
  - [ ] Confirm redirect lands on `/billing/success`, not `/settings`
  - [ ] Confirm green checkmark + "You're subscribed." renders
  - [ ] Confirm DB: `stripeSubscriptionId IS NOT NULL`
  - [ ] Confirm Stripe Dashboard: an active subscription on the
        platform customer
  - [ ] Click "Back to dashboard" → banner is gone
- [ ] **End-to-end manual test with webhook artificially blocked
      (simulating prod outage):**
  - [ ] Stop `stripe listen`
  - [ ] Same flow as above
  - [ ] Confirm subscription still gets created (synchronous path
        carries it)
  - [ ] Re-start `stripe listen`, Stripe re-delivers the
        `checkout.session.completed` event → webhook handler no-ops
        (`ensureActivation` returns `active`, no double-creation)
- [ ] **End-to-end manual test with user closing tab on Stripe
      before redirect** (simulating the redirect-path interruption):
  - [ ] Click Subscribe, enter card on Stripe, click Pay
  - [ ] Close the tab before Stripe redirects back
  - [ ] Confirm webhook still creates the subscription
  - [ ] Re-load dashboard → banner is gone

## Out of scope

- Changing how the Subscribe button looks or where it appears (spec 51)
- Adding "Subscribe-with-existing-card" smart routing — covered above
  as over-engineering for a state that shouldn't occur post-fix
- Adding a /billing/success path for the dunning add-card flow (that's
  a customer-facing flow, different audience, separate spec if needed)
- Migrating `/settings?billing=success` callers (none exist outside
  this Checkout `success_url`)
- Analytics dedup for `billing_card_captured` event (handled by
  emitting from webhook only)

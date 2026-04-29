# Spec 36 — Merchant-branded /welcome-back page (kill the Winback logo)

**Phase:** Pre-launch hardening
**Depends on:** Spec 23 (reactivation Checkout — `/welcome-back?recovered=…`),
Spec 35 (dunning Checkout — same target page)
**Estimated time:** ~half a day (v1, text-based)

---

## Context

The customer journey for *both* recovery flows ends at our
`/welcome-back` page:

- **Reactivation (Spec 23):** customer cancelled deliberately → got a
  win-back email → clicked → `/api/reactivate/.../checkout` → Stripe
  Checkout (Stripe-hosted, **merchant-branded** via the merchant's
  Stripe dashboard branding) → `success_url: /welcome-back?recovered=true`
- **Dunning (Spec 35):** customer's card failed → got a dunning email →
  clicked → `/api/update-payment/...` → Stripe Checkout setup mode
  (also merchant-branded) → `success_url: /welcome-back?recovered=true&session_id=…`

In both cases, the customer just spent ~30 seconds on a Stripe page
showing the *merchant's* business name (and optionally logo, primary
color, support URL) — they think they're a "Fitness App" customer, not
a "Winback" customer. Then we redirect them to *our* `/welcome-back`
which renders the **Winback** lightning-bolt logo + wordmark
(`<Logo />` from [components/logo.tsx](../components/logo.tsx) at
[app/welcome-back/page.tsx:41](../app/welcome-back/page.tsx)).

That breaks the merchant's brand illusion at the most emotional moment
of the funnel — the "you saved your subscription" reveal. Worse, it
exposes the third-party recovery system to the end customer, which
some merchants explicitly don't want.

This spec replaces the Winback logo on `/welcome-back` with the
**merchant's** brand identity, derived from data we already have.

## User-approved decisions

- **v1 is text-based.** Show the merchant's `product_name` (already in
  `wb_customers`) styled as a wordmark. Optional: hint of color from
  Stripe's `account.settings.branding.primary_color` if present. No new
  schema, no merchant onboarding step.
- **v2 (separate spec, later)** adds real per-merchant logo upload and
  storage. Out of scope here.
- **Both flows fixed in one shot.** Spec 23 reactivation + Spec 35
  dunning hit the same page; one fix covers both.
- **Chooser page included.** [app/reactivate/[subscriberId]/page.tsx](../app/reactivate/[subscriberId]/page.tsx)
  was the third subscriber-visible page rendering the Winback logo —
  added late in implementation when noticed during click-through.
  Same pattern as `/welcome-back`: pull merchant wordmark from the
  already-loaded `customer` row, render or fall through to blank.
  Same goal: the Winback logo must be invisible to merchants'
  subscribers across **all** customer-facing pages.

---

## Goals

| # | Goal | Mechanism |
|---|------|-----------|
| 1 | Customer never sees Winback logo or wordmark on `/welcome-back` | Replace `<Logo />` with merchant identity (or neutral fallback) |
| 2 | Brand consistency between Stripe Checkout (which they just saw) and `/welcome-back` (which they're about to see) | Pull merchant identity from sources already in scope: `wb_customers.product_name`, optionally Stripe's `account.settings.branding` |
| 3 | Zero merchant onboarding action | Stripe Connect default branding + our existing `product_name` field cover the v1 — same philosophy as Spec 35 |
| 4 | Direct navigation to `/welcome-back` (no params) doesn't expose Winback either | Generic neutral copy, not Winback logo, when no customer can be resolved |

---

## Non-goals

- **Logo image upload UI in `/settings`.** v2.
- **Theming the page** with the merchant's primary/secondary colors as
  full background/button colors. Aesthetic risk + custom-CSS-per-page
  burden. v1 stays neutral; the merchant's name is the only branded
  element.
- **Custom redirect after success** (e.g. send the customer back to the
  merchant's app login). Out of scope; merchants who want this will
  ask for it as a separate spec.
- **i18n / per-merchant copy overrides.** English only; one set of
  strings for v1.
- **Customer-facing audit trail** ("you can manage your subscription
  here"). The page is a thank-you/sorry moment, not a portal.
- **Spec 23/35 webhook changes.** Those flows are unchanged. Only the
  redirect URL gets a new query param; only the page renders differently.

---

## Detection (single SQL truth)

No schema changes. The test is **visual**:

1. Trigger either flow (re-run `scripts/test-spec35-link.ts` or click a
   reactivation link)
2. Complete Stripe Checkout
3. Land on `/welcome-back?recovered=true&customer=<wb_customer_id>`
4. Assert: page shows the merchant's `product_name` styled as a
   wordmark. Winback logo is **not present** anywhere on the DOM.

Behaviourally:

```sql
-- Spot-check what merchant identity will render for any subscriber:
SELECT cs.id AS subscriber_id,
       cs.email,
       c.id AS customer_id,
       c.product_name,
       c.founder_name,
       c.stripe_account_id
FROM   wb_churned_subscribers cs
JOIN   wb_customers c ON c.id = cs.customer_id
WHERE  cs.cancellation_reason = 'Payment failed'
ORDER  BY cs.created_at DESC LIMIT 5;
```

---

## Code changes

### 1. Pass `customer` in every `/welcome-back` URL we emit

Four places to update; mechanical:

| File | Change |
|---|---|
| [app/api/update-payment/[subscriberId]/route.ts](../app/api/update-payment/[subscriberId]/route.ts) | Append `&customer=${subscriber.customerId}` to `success_url` and `cancel_url` |
| [app/api/reactivate/[subscriberId]/checkout/route.ts](../app/api/reactivate/[subscriberId]/checkout/route.ts) | Same |
| [app/api/reactivate/[subscriberId]/route.ts](../app/api/reactivate/[subscriberId]/route.ts) | Same — already-recovered + reason redirects |
| [app/reactivate/[subscriberId]/page.tsx](../app/reactivate/[subscriberId]/page.tsx) | Same |

`customer` is the **Winback** customer UUID (`wb_customers.id`), not
the Stripe customer ID. Page logic resolves merchant identity from it.

It's not sensitive — Stripe-hosted Checkout already exposes the
merchant's brand publicly to anyone with the session URL. Worst-case
enumeration just reveals merchant logos we'd happily put on a public
"customers" page anyway.

### 2. Rewrite `app/welcome-back/page.tsx`

```ts
import { db } from '@/lib/db'
import { customers } from '@/lib/schema'
import { eq } from 'drizzle-orm'

interface MerchantIdentity {
  productName: string
  primaryColor: string | null   // hex, from stripe.accounts.retrieve, optional
}

async function resolveMerchantIdentity(
  customerId: string | undefined,
): Promise<MerchantIdentity | null> {
  if (!customerId) return null
  const [row] = await db
    .select({ productName: customers.productName, founderName: customers.founderName })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1)
  if (!row) return null
  return {
    productName: row.productName ?? row.founderName ?? '',
    primaryColor: null,         // v1 — leave hook for v2 to populate from Stripe
  }
}
```

Then in the JSX, replace `<Logo />` with:

```tsx
{merchant ? (
  <div className="mb-8 text-2xl font-semibold text-slate-900 tracking-tight">
    {merchant.productName}
  </div>
) : (
  // Direct nav / unresolvable customer — show NOTHING above the card.
  // Crucially: NOT the Winback logo. A blank space is better than
  // exposing the third-party brand to a customer who shouldn't know
  // we exist.
  <div className="mb-8" />
)}
```

The card's heading and body copy stay generic ("Welcome back!", "No
worries.", etc.) — they don't name Winback or the merchant, so they
work universally.

### 3. Remove the Winback-only `<Logo />` import

```ts
// Drop this line:
import { Logo } from '@/components/logo'
```

The `<Logo />` component itself stays — `/login`, `/register`, `/dashboard`
etc. all legitimately use it. Just not on `/welcome-back`.

### 4. Stripe `account.settings.branding` (deferred to v2)

Reading `stripe.accounts.retrieve(stripeAccountId).settings.branding`
gives us: `icon` (file ID), `logo` (file ID), `primary_color`,
`secondary_color`. Each render adds ~150-300ms of Stripe API latency,
plus a `stripe.fileLinks.create` per image to get displayable URLs.

For v1, **don't fetch from Stripe.** Page must render fast (it's a
thank-you moment, latency hurts). v2 caches Stripe branding in
`wb_customers` columns + refreshes on `account.updated` webhook events.

---

## Tests (~5 new)

`src/winback/__tests__/welcome-back-page.test.ts` (new):

- Renders merchant's `product_name` when valid `customer` param + matching row
- Falls back to `founder_name` when `product_name` is null
- Renders nothing above the card when `customer` param is missing
- Renders nothing above the card when `customer` param resolves to no row (404 / spoofed UUID)
- Snapshot: NO `<svg>` from `<Logo />` ever appears in output, in any branch (regression guard)

`src/winback/__tests__/update-payment-route.test.ts` (extend):

- Asserts `success_url` and `cancel_url` now contain `&customer=<wb_customer_id>`

`src/winback/__tests__/reactivate-checkout-route.test.ts` (extend if it exists, otherwise inline):

- Same assertion on the reactivation flow's success/cancel URLs

---

## Verification

```bash
git checkout -b feat/spec-36-welcome-back-brand
# (after writes)
npx tsc --noEmit
npx vitest run

# End-to-end manual A — dunning flow:
# 1. Re-run scripts/test-spec35-link.ts (sends T1 email with new
#    update-payment link)
# 2. Click link in inbox → Stripe Checkout (merchant-branded as before)
# 3. Complete with test card 4242 4242 4242 4242
# 4. EXPECTED: lands on /welcome-back?recovered=true&customer=<uuid>
#    - page shows the merchant's product_name as a wordmark above the card
#    - NO Winback lightning-bolt logo, NO "Winback" wordmark anywhere
#    - card copy is the generic "Welcome back!" message

# End-to-end manual B — reactivation flow:
# 1. Pick a churned subscriber from a deliberate cancellation
# 2. Hit /reactivate/<subscriberId>
# 3. Complete Stripe Checkout
# 4. EXPECTED: same outcome on /welcome-back

# Direct-nav check:
# Open http://localhost:3000/welcome-back?recovered=true (no customer param)
# EXPECTED: card renders, NO Winback logo, blank space above where the
# merchant wordmark would have been
```

---

## Edge cases handled

1. **Direct navigation, no params.** Generic copy, no logo at all. The
   page used to show the Winback logo here — we change that to a blank
   space. Worst case looks slightly empty; better than leaking our
   brand to a confused customer.
2. **`customer` param is a malformed UUID.** Postgres throws on cast
   (we hit this earlier in this codebase). Wrap the DB lookup in
   try/catch → fall through to "no merchant identity" branch, render
   the no-logo neutral state.
3. **`customer` param exists but row missing** (deleted merchant).
   Same fallback. Logging a `warn` would be useful for ops.
4. **Merchant has no `product_name`** (older record, OAuth callback
   didn't capture it). Fall back to `founder_name`. If both null, no
   wordmark — neutral state.
5. **Long product names.** Truncate at ~40 chars with ellipsis. The
   styling uses `tracking-tight` so 40 chars fits comfortably on
   mobile. Anything pathological gets cut.
6. **Stripe Checkout's own success page versus our redirect.** The
   customer always lands on Stripe's "Payment successful" interim
   screen for ~1s before Stripe redirects to `success_url`. Our page
   is the second screen; Stripe's screen is *also* merchant-branded.
   So the cross-fade brand-wise is: merchant Checkout → merchant
   "success" → our `/welcome-back` (now also merchant-named) → done.
   No discontinuity.
7. **Failure path (`recovered=false`)** uses the same merchant
   resolution — even the "No worries" page shows the merchant's name,
   not Winback. Customer's experience stays consistent across success
   + failure.
8. **HTML title tag.** Currently `<title>` defaults to whatever
   `app/layout.tsx` sets ("Winback" most likely). Out of scope to
   override per-merchant — the visible page is what matters; title
   bars rarely register at this point in the funnel. v2.

---

## Out of scope (future)

- **Spec 37 (planned next):** Per-merchant logo upload + storage.
  Adds:
  - `wb_customers.logo_url` (text)
  - `/settings` upload UI (Vercel Blob storage, public URL)
  - `/welcome-back` renders `<img>` instead of text wordmark when
    `logo_url` is set
- **Spec 38:** Pull `branding.primary_color` from Stripe + use as accent
  on the `/welcome-back` heading underline. Real per-merchant theming
  beyond color is *not* on the roadmap.
- Per-merchant `<title>` and favicon on `/welcome-back`.
- Custom redirect target after success (back to merchant's app, etc.).
- Localised welcome-back copy.

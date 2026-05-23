> **⚠️ Historical reference — pricing model was rewritten on 2026-05-23.**
> The "$99/mo + 1× MRR per recovery" and "14-day refund window" mechanics
> described in this doc no longer exist. Current model: tiered flat
> monthly fee priced by the customer's own MRR (Starter $99 / Growth
> $299 / Scale $699 / Enterprise sales-handled), no per-recovery
> charges, no refund windows. See `CLAUDE.md` and
> `/Users/tejay/.claude/plans/we-are-going-to-memoized-kernighan.md`
> for the current model. This doc is preserved as historical record.

# Spec 62 — Pin Stripe API version (SDK + webhook endpoint)

## Context

Two production regressions this week (Specs 57 and 61) were both
"Stripe restructured a field and our code didn't notice." Each broke
a billing-critical path silently:

- **Spec 57** — `invoice.subscription` moved to
  `invoice.parent.subscription_details.subscription`. Every dunning
  recovery failed to record.
- **Spec 61** — `invoice.lines.data[].invoice_item` moved to
  `invoice.lines.data[].parent.invoice_item_details.invoice_item`.
  Every 14-day refund silently failed to issue the credit note.

Both happened because we don't pin a Stripe API version anywhere.
Today's stack:

- **SDK constructor:** `new Stripe(key)` — no `apiVersion` option, so
  the SDK uses its own internal default, which can change when the
  `stripe` npm package is bumped.
- **Webhook endpoints in Stripe Dashboard:** set to "(default)" —
  Stripe delivers events at whatever the *account's* default version
  is at delivery time. Stripe can advance this account default with
  little warning, and the response shapes change with it.

Without a pin, every Stripe API version change is a random surprise
break in production, found one bug at a time after it ships.

## Goals

- Pin a specific Stripe API version (`2026-03-25.dahlia`, the version
  we've validated against this week) across:
  - the SDK constructor (so all our API calls send `Stripe-Version`)
  - the webhook endpoints in Stripe Dashboard (so all events arrive
    shaped to the same version)
- Centralize Connect-account Stripe client construction behind a
  single helper, mirroring the existing `getPlatformStripe()`.
- Document the pin and the deliberate upgrade procedure in CLAUDE.md
  so future versions never auto-bump under us.
- All Spec 57 / 58 / 59 / 60 / 61 fixes remain green after the pin.

## Non-goals

- **Not upgrading the Stripe API version.** We pin to what we're
  already on. The goal is to lock the current contract, not move it.
- **Not refactoring scripts/* to use helpers.** Test scripts are
  out-of-band tooling; their lack of pin doesn't affect prod.
  Follow-up if useful.
- **Not pinning the Stripe Node SDK package version itself in
  package.json beyond what's already there.** The `apiVersion`
  option is independent of the SDK package version and is what
  governs request/response shapes. The SDK can be upgraded freely
  for bug fixes etc. without touching the pinned API version.

## Choice of version

`2026-03-25.dahlia` — the version Stripe is currently serving us
empirically (confirmed across every webhook delivery and API
response we've inspected this week). Pinning to "exactly what we're
already on" makes this a no-behavior-change deployment. We can
deliberately upgrade later via the documented process.

## Code paths touched

| File | Change |
|---|---|
| `src/winback/lib/platform-stripe.ts` | Add `STRIPE_API_VERSION` const; pass `{ apiVersion: STRIPE_API_VERSION }` to `new Stripe(...)` in `getPlatformStripe()` |
| `src/winback/lib/stripe.ts` | Export `STRIPE_API_VERSION` and a new `getConnectStripe(accessToken: string): Stripe` that pins the same version |
| `src/winback/lib/dunning-checkout.ts` | Replace `new Stripe(accessToken)` with `getConnectStripe(accessToken)` |
| `src/winback/lib/backfill.ts` | Same |
| `app/reactivate/[subscriberId]/page.tsx` | Same |
| `app/api/reactivate/[subscriberId]/route.ts` | Same |
| `app/api/reactivate/[subscriberId]/checkout/route.ts` | Same |
| `app/api/update-payment/[subscriberId]/route.ts` | Same |
| `app/api/stripe/webhook/route.ts` | Three direct instantiations (lines 22, 699, 851) — replace with helpers. Line 22 is platform; 699 and 851 are Connect. |
| `app/api/test/winback-flow/route.ts` | Same (Connect) |
| `CLAUDE.md` | New section "Stripe API version pin" — names the version, links to migration guide, and gives the upgrade procedure |

## Helper implementation (illustrative)

```ts
// src/winback/lib/stripe.ts
import Stripe from 'stripe'

/**
 * Spec 62 — pinned Stripe API version. Every Stripe client constructor
 * across our runtime code uses this, and the webhook endpoints in the
 * Stripe Dashboard are pinned to the same value. Upgrading is a
 * deliberate decision documented in CLAUDE.md.
 */
export const STRIPE_API_VERSION = '2026-03-25.dahlia' as const

export function getConnectStripe(accessToken: string): Stripe {
  return new Stripe(accessToken, { apiVersion: STRIPE_API_VERSION })
}

// ... existing exports ...
```

```ts
// src/winback/lib/platform-stripe.ts
import Stripe from 'stripe'
import { STRIPE_API_VERSION } from './stripe'

export function getPlatformStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION })
}
```

Call-site refactor pattern:

```ts
// Before
import Stripe from 'stripe'
const stripe = new Stripe(accessToken)

// After
import { getConnectStripe } from '@/src/winback/lib/stripe'
const stripe = getConnectStripe(accessToken)
```

## Stripe Dashboard step (human action, required)

After code lands and deploys:

1. Stripe Dashboard → Developers → Webhooks
2. For each webhook endpoint (Connect + platform):
   - Click endpoint
   - "API version" → change from "(default)" to `2026-03-25.dahlia`
3. Re-trigger one test webhook from each endpoint and verify our local
   dev still parses correctly (we already pass against this version
   today, so this is sanity-check only)

Without this step, code requests use the pinned version but webhook
event payloads still use the account default — code shape and event
shape can diverge.

## Documentation (CLAUDE.md addition)

New section near the existing "Environment variables" section:

> ### Stripe API version pin
>
> All runtime Stripe clients use API version **`2026-03-25.dahlia`**
> via `STRIPE_API_VERSION` in `src/winback/lib/stripe.ts`. Webhook
> endpoints in Stripe Dashboard are pinned to the same value.
>
> **Do not change this without doing the upgrade ritual:**
>
> 1. Read Stripe's migration guide for every version between current
>    and target: https://docs.stripe.com/upgrades
> 2. Audit every field access on Stripe objects in our code for
>    fields that were renamed, moved, or removed (especially nested
>    fields on `Invoice`, `InvoiceLineItem`, `Subscription`,
>    `Checkout.Session`, `Charge`).
> 3. Update the `STRIPE_API_VERSION` constant on a feature branch.
> 4. Run the full vitest suite + the Tier 1/2/3 e2e billing tests
>    against dev. Confirm all green.
> 5. Update each Stripe Dashboard webhook endpoint to the new version.
> 6. Deploy code first, then update the Dashboard webhook pins. (The
>    code must be tolerant of either old or new shape during the
>    deploy window — Spec 57 / 61's helpers already handle this.)
>
> Stripe never deprecates historical API versions retroactively, so
> staying pinned indefinitely is safe. Upgrade only when we want a
> specific new feature.

## Edge cases handled

1. **Old replayed events at a different shape** — Spec 57 / 61 helpers
   already handle dual-shape parsing. Pin doesn't disable that
   fallback.
2. **Test scripts using `new Stripe(...)`** — they're not pinned (out
   of scope). They'll use the SDK's internal default. If a script
   ever behaves differently from prod, that's a signal to consider
   pinning them too — but not a billing risk because scripts only
   run in dev.
3. **SDK package upgrade** — bumping the `stripe` npm package
   doesn't change the API version contract. Our pin overrides the
   SDK's own default.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` 574/574 still pass
- [ ] Re-run Tier 1.1, 1.2, 1.4, 2.1, 2.2, 2.3, 3.1, 3.2 e2e — all
      previously-passing scenarios remain green (the version is the
      one we've already been running against, so behavior is
      identical)
- [ ] Stripe Dashboard step done for both webhook endpoints
- [ ] CLAUDE.md updated with the new section + upgrade ritual

## Out of scope

- Tier 3.3 (refund-window-expired) — runs after this lands.
- Scripts/* refactor to use helpers (separate cleanup PR).
- Adding similar pin discipline for other third-party services
  (Resend, Anthropic) — different concern, different mechanism.

## Why this is worth doing now

Two silent prod regressions in one week is enough signal that "no
pin" is the wrong default for a billing-critical product. This
spec adds a structural fix that prevents the entire class of bug,
not just one instance.

Cost: roughly 12 small edits, one CLAUDE.md addition, and one
Dashboard click per webhook endpoint. Worth doing before any further
Tier 3/4/5/6/7 testing — those tests will keep finding API-shape
bugs as long as we're vulnerable to silent version drift.

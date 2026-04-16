# Spec 14 — Stripe onboarding: conversion redesign + first-party telemetry

**Phase:** Shipped (April 2026)
**Depends on:** Spec 03 (original onboarding), Spec 12 (onboarding-v2 single-step)
**Supersedes in part:** Spec 12 copy + trust layout for `/onboarding/stripe`

---

## Summary

`/onboarding/stripe` is the single hardest conversion point in the product —
the user has just signed up and is being asked to grant OAuth access to
Stripe, the source of truth for their business. Bounces here waste every
upstream marketing dollar and we never get the chance to deliver the aha.

The v2 onboarding shipped in Spec 12 was already single-step, but had two
problems the team only noticed once we started watching real behaviour:

1. **Credibility gap.** The page advertised *"Read-only access to
   subscriptions and customers,"* but `/api/stripe/connect` actually requests
   `scope: 'read_write'`. Stripe's consent screen shows the true scope, so a
   careful reader would catch the mismatch and lose trust before they even
   clicked.
2. **No telemetry.** We had zero analytics in the codebase — no PostHog, no
   Plausible, no events table. We couldn't tell how many people saw the
   page, how many clicked Connect, how many bailed on Stripe's consent
   screen, or how many errored out at the callback. Without numbers there's
   nothing to iterate against.

A third problem emerged while designing the fix: an over-reassured page
reads as *"why are you defending so hard?"*. The right mental model was
**"make it easy for people who would have clicked anyway, let sceptics
find out more if they want"** — not "bury the user in trust copy."

This spec is the retrospective record of what was built in response.

---

## What changes

### New

| File | Purpose |
|------|---------|
| `src/winback/migrations/010_wb_events.sql` | Creates the `wb_events` table (see schema below) |
| `src/winback/lib/events.ts` | `logEvent()` helper — server-side, swallow-on-error |
| `src/winback/__tests__/events.test.ts` | Unit tests for the helper (4 cases, all green) |
| `app/api/events/track/route.ts` | Authenticated POST endpoint for client-fired events, whitelisted + rate-limited |
| `components/onboarding/stripe-connect-card.tsx` | Extracted `'use client'` component so we can fire `connect_clicked` before navigating |

### Modified

| File | Change |
|------|--------|
| `lib/schema.ts` | Added `wbEvents` pgTable definition with two indexes |
| `app/onboarding/stripe/page.tsx` | Full redesign: minimal default view + progressive disclosure. Read-only claim removed. Fires `onboarding_stripe_viewed` on render. Renders `?error=...` banners |
| `app/api/stripe/connect/route.ts` | Fires `oauth_redirect` before the 302 to Stripe |
| `app/api/stripe/callback/route.ts` | Fires `oauth_completed` / `oauth_denied` / `oauth_error` with structured properties |

### Unchanged (but referenced)

- `components/powered-by-stripe.tsx` — primary trust anchor, kept as the only visual badge
- `app/dpa/page.tsx`, `app/privacy/page.tsx`, `app/subprocessors/page.tsx` — linked from the one-line governance footer
- `app/faq/page.tsx` — existing "Stripe access & your data" section is already aligned with the new copy; no edits needed

---

## The three design decisions worth remembering

### 1. Minimal default, progressive disclosure

**Principle:** the confident clicker sees almost nothing; the sceptic clicks
once and gets the full picture.

What's visible above the fold:

```
Logo

Connect Stripe.
Winback reads your cancellations and failed payments, and restarts
subscriptions your customers click to restart.

┌───────────────────────────────────┐
│ 💳 Stripe           [ Connect → ] │
│    Subscription data & events      │
└───────────────────────────────────┘
                      Powered by Stripe

▸ What access does this give Winback?
▸ What happens on Stripe's next screen?
▸ How do I revoke later?
▸ Where does my data live?

DPA · Privacy · Subprocessors            Email support
```

What's collapsed behind the first disclosure:

- `We can read` list (4 items — active subs, cancellations, email/plan/MRR, cancel reason)
- `We cannot` list (4 items — charge, refund, change prices, create subscriptions from nowhere)
- `We write only when your customer clicks` list (**Restart a cancelled subscription** / **Fix a failed card**) + one-sentence scope note

The earlier draft had all of this rendered above the fold as a permission
matrix. Real readers told us (via taste, not data) that it felt like a legal
preamble and signalled worry. Folding it into a disclosure cut the visible
sentence count from ~15 to ~3 without losing any substance — it moved from
"being pushed" to "available on tap."

### 2. "Fix a failed card" (intention copy, not mechanism copy)

An early version of the write-actions list said *"Retry a failed card after
your customer updates it."* That was mechanically wrong — our code calls
`stripe.billingPortal.sessions.create()` to mint a hosted link; Stripe's
own Smart Retries does the actual retry, not us.

It was also the wrong frame. The user doesn't care which API we call; they
care what the customer gets. The corrected bullet:

> - Restart a cancelled subscription
> - Fix a failed card

Both lines describe **the customer's intent** that triggers our write
(customer clicked reactivate → we restart; customer clicked update-payment →
we open a portal so they can fix the card). The technical detail lives in
the one-sentence scope note below — readers who want it find it, readers
who don't aren't asked to parse API names.

### 3. CTA as the visual focus, not just a link

The initial button was the standard primary pill (`px-5 py-2 text-sm`). On
a page whose whole job is to get one click, that's under-scaled. It
shipped as:

```tsx
className="bg-[#0f172a] text-white rounded-full px-7 py-3 text-base font-medium
           hover:bg-[#1e293b] shadow-sm hover:shadow-md transition-shadow
           whitespace-nowrap
           focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
```

Same brand colour (`#0f172a`), same pill shape, but:

- Matches the landing-hero CTA size (`px-7 py-3 text-base`) so it's
  unmistakably the primary action
- Adds `shadow-sm → hover:shadow-md` for a light depth cue
- Gets a proper focus ring (a11y bonus we didn't have before)
- Label is `Connect Stripe →` — arrow adds direction

We deliberately did **not** change it to blue (clashes with the blue icon
badge left of it; dark slate is the system-wide primary) or add a pulse
animation ("really click me" energy is the wrong signal for a trust page).

---

## Telemetry architecture

### Why first-party and not PostHog

We considered PostHog, Plausible, Vercel Analytics, and a custom table.
The onboarding page is authenticated (we already have `session.user.id`),
we only need five events, and the product's whole privacy posture (no
cookies, zero-retention AI, first-party-everything) argues against a
third-party pixel on the most sensitive page in the app. A tiny first-party
table was ~60 lines of helper code and keeps the promise.

The swap-in path to PostHog later is trivial — replace the body of
`logEvent()` with `posthog.capture()`. If we do that, it'll be when we
need funnels or replay across ≥10 pages, not for this one.

### Schema — `wb_events`

```sql
CREATE TABLE wb_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES wb_customers(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES wb_users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  properties  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX wb_events_name_created_idx     ON wb_events (name, created_at DESC);
CREATE INDEX wb_events_customer_created_idx ON wb_events (customer_id, created_at DESC);
```

- `customer_id` is `CASCADE` — a GDPR deletion of a customer takes their
  telemetry with them.
- `user_id` is `SET NULL` — preserves funnel counts even if the user
  account is deleted, because the funnel is a property of the *cohort*,
  not the individual.
- `properties` is a free-form JSONB blob. Keep it small — this is not a
  log store.

### `logEvent()` contract

```ts
logEvent({
  name: string,
  customerId?: string | null,
  userId?: string | null,
  properties?: Record<string, unknown>,
}): Promise<void>
```

Two invariants that must not be broken:

1. **Telemetry never throws.** The helper wraps the insert in a try/catch
   and `console.error`s on failure. A logging outage must not break a
   user's signup.
2. **Identity is server-derived.** Client code never provides
   `customerId` or `userId` in the body. For client-fired events, they
   go through `/api/events/track`, which reads the session and attaches
   identity itself. This closes off the "malicious client floods the
   table" vector.

### Events currently fired

| Event | Fired from | Properties |
|---|---|---|
| `onboarding_stripe_viewed` | `app/onboarding/stripe/page.tsx` server render | `{ hasError, errorType? }` |
| `connect_clicked` | `StripeConnectCard` client → POST `/api/events/track` | `{ source: 'onboarding' }` |
| `oauth_redirect` | `app/api/stripe/connect/route.ts` (pre-302) | `{}` |
| `oauth_completed` | `app/api/stripe/callback/route.ts` success path | `{ stripeAccountId, firstConnect }` |
| `oauth_denied` | `app/api/stripe/callback/route.ts` (user cancelled on Stripe) | `{ errorType: 'denied' }` |
| `oauth_error` | `app/api/stripe/callback/route.ts` (missing params / invalid state / token exchange failed) | `{ errorType: 'missing_params' \| 'invalid_state' \| 'token_exchange_failed' }` |

The funnel reads top to bottom:

```
viewed → clicked → redirect → (completed | denied | error)
```

The gap between any two rows is where you're losing people. The gap
between `redirect` and `completed` is especially important — that's the
drop *on Stripe's consent screen*, which we can't instrument directly
but can bound by subtraction.

### Client-fired event whitelist

`app/api/events/track/route.ts` validates `name` against a hard-coded
Zod enum (currently `['connect_clicked']`). Extend the enum when a new
client-side event is needed. Everything else is rejected with 400, so
the table cannot be polluted with arbitrary client data.

The route also carries a 1-second in-memory per-user rate limit. At our
current scale that's fine; it should move to a durable store (Redis/Upstash)
before we ever deploy multiple compute regions.

---

## How to read the funnel

Set up (per shell):

```bash
source <(grep -E '^DATABASE_URL=' .env.local | sed 's/^/export /')
```

### 1. Latest events (live debugging)

```sql
SELECT name, properties, created_at
FROM wb_events
ORDER BY created_at DESC
LIMIT 10;
```

### 2. Funnel — last 7 days

```sql
SELECT name, COUNT(*) AS count
FROM wb_events
WHERE name IN (
  'onboarding_stripe_viewed','connect_clicked','oauth_redirect',
  'oauth_completed','oauth_denied','oauth_error'
)
  AND created_at > now() - interval '7 days'
GROUP BY name
ORDER BY
  CASE name
    WHEN 'onboarding_stripe_viewed' THEN 1
    WHEN 'connect_clicked'          THEN 2
    WHEN 'oauth_redirect'           THEN 3
    WHEN 'oauth_completed'          THEN 4
    WHEN 'oauth_denied'             THEN 5
    WHEN 'oauth_error'              THEN 6
  END;
```

### 3. Per-user timeline (debug a specific signup)

```sql
SELECT e.name, e.properties, e.created_at
FROM wb_events e
JOIN wb_users u ON u.id = e.user_id
WHERE u.email = 'founder@example.com'
ORDER BY e.created_at;
```

### 4. Error breakdown

```sql
SELECT properties->>'errorType' AS error_type, COUNT(*)
FROM wb_events
WHERE name IN ('oauth_denied','oauth_error')
  AND created_at > now() - interval '7 days'
GROUP BY error_type
ORDER BY count DESC;
```

---

## What we deliberately didn't do

- **PostHog / Plausible / Vercel Analytics.** Five server-side events don't
  justify a vendor, a cookie debate, or bundle weight on this page.
- **Session replay.** Events plus the occasional user interview will carry
  us until we hit ≥100 signups/month.
- **A `/demo` or Cal.com booking page.** The in-page FAQ accordion + a
  `mailto:support@winbackflow.co` link is the fallback for genuine
  dealbreakers.
- **SOC2 / ISO / customer-logo badges.** We don't have them; claiming them
  would be worse than omitting them. The only visual trust anchor is
  Powered by Stripe.
- **A/B test harness.** Premature. Ship v1, read the funnel for two weeks,
  iterate by hand.
- **Dashboard UI for the funnel.** SQL queries are fine for v1. A small
  `/admin/funnel` page is the obvious follow-up, but not worth blocking
  the ship.
- **Stripe revoke API call on disconnect.** The existing
  `app/settings/disconnect-button.tsx` → `/api/stripe/disconnect` path
  still only nulls the token locally. Calling Stripe's revoke endpoint
  is a correct thing to add but out of scope for this change — filed as
  a follow-up.

---

## Verification that shipped

- `npx tsc --noEmit` — clean
- `npx vitest run` — 55 tests green (51 pre-existing + 4 new in `events.test.ts`)
- Manual walkthrough on the dev server: view → click → redirect → complete
  path verified, plus the denied-then-retry path
- Migration applied to Neon before the branch merged; indexes present

---

## Open follow-ups (tracked, not filed)

- Stripe revoke API call on disconnect (credibility-adjacent to this change)
- `/admin/funnel` dashboard once the founder is reading the numbers weekly
- PostHog or similar if/when we need funnels across multiple pages
- Durable per-user rate limit on `/api/events/track` (Redis/Upstash) if we
  ever deploy multi-region

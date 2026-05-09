# Spec 47 — Platform-side webhook + dual-secret signature verification

## Context

Today, [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts) is wired
to a single Stripe webhook destination — the **Connect** webhook on the
platform account, which delivers events from connected merchant accounts
(`event.account` is set on every event).

But the same route handler has five branches that only fire when
`!event.account` — i.e. events on **Winback's own** Stripe account, not
delivered by the Connect webhook:

| Event branch | Handler | What it does | Importance |
|---|---|---|---|
| `checkout.session.completed` (`metadata.flow=platform_card_capture`) | [`processPlatformCardCapture`](../app/api/stripe/webhook/route.ts#L902) | Sets default PM on the platform Customer + calls `triggerActivation` which **creates the $99/mo Stripe Subscription** | 🔴 Billing bootstrap — without this, no merchant can ever be billed |
| `customer.subscription.deleted` | [`processPlatformSubscriptionDeleted`](../app/api/stripe/webhook/route.ts#L973) | Clears `customers.stripeSubscriptionId` so a future recovery can cleanly create a new sub | 🟡 Cancel-and-return is broken without it |
| `invoice.payment_failed` | [`processPlatformInvoiceEvent`](../app/api/stripe/webhook/route.ts#L1002) | Logs + sends `sendPlatformPaymentFailedEmail` to the founder | 🟡 No payment-failed email to merchants |
| `invoice.payment_succeeded` | same | Observability log only | 🟢 Metrics blind-spot |
| `invoice.paid` | same | Catches manual portal pays after a stuck invoice | 🟢 Metrics edge case |

These branches have never fired in production because no platform-side
webhook destination is registered. Two of them are **launch blockers**
(card capture, payment-failed email) and the cancellation cleanup is a
near-blocker.

To fix this we need:

1. A **second** Stripe webhook destination on the platform account, with
   "Listen to events on Connected accounts" **off**, subscribed to the
   five events above. Same URL as the Connect webhook (`/api/stripe/webhook`).
2. A code change so the route handler accepts events signed by **either**
   webhook destination's secret. Stripe gives each destination its own
   `whsec_...` and signs each event with whichever destination delivered it;
   the handler currently verifies only against `STRIPE_WEBHOOK_SECRET`.

This spec covers the code change + the rollout sequence. The Stripe-side
destination creation and env-var setup happen in the Stripe Dashboard /
Vercel CLI per the runbook below — no code change required for those.

## Goals

- Route handler verifies signatures against either `STRIPE_WEBHOOK_SECRET`
  (Connect) **or** `STRIPE_PLATFORM_WEBHOOK_SECRET` (platform), accepting
  whichever matches.
- Backwards-compatible: if `STRIPE_PLATFORM_WEBHOOK_SECRET` is unset, the
  loop reduces to the existing single-secret behavior. This is what makes
  it safe to ship the code change *before* creating the new Stripe
  destination.
- Existing `webhook_signature_invalid` observability event preserved
  (same name, same `properties` shape) so the admin dashboard's error
  counter doesn't lose history.
- No regression to existing test suite.

## Non-goals

- No new tests for the dual-secret loop itself. Existing webhook tests
  bypass `constructEvent` (they invoke `processPlatformCardCapture` etc.
  directly), and the new code is a thin loop over an existing API. A
  unit test would mostly mock our way around `stripe.webhooks.constructEvent`
  without testing real signature math.
- No refactor of the platform-side handlers themselves — they exist and
  work, this spec only fixes the wiring that lets events reach them.
- No env var renaming for clarity (e.g. renaming `STRIPE_WEBHOOK_SECRET` →
  `STRIPE_CONNECT_WEBHOOK_SECRET`). Keeps the diff minimal; can rename
  later if it bothers us.

## Schema / migration

None.

## Code paths touched

### 1. [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts) — lines 87–107

Replace the current `constructEvent` block with a loop that tries each
configured secret in order, accepts the first that verifies, and falls
through to the existing 400 path only if **all** configured secrets fail:

```ts
const rawBody = Buffer.from(await req.arrayBuffer())
const sig = req.headers.get('stripe-signature') ?? ''

let event: Stripe.Event | undefined
let lastErr: unknown = null

const secrets = [
  process.env.STRIPE_WEBHOOK_SECRET,
  process.env.STRIPE_PLATFORM_WEBHOOK_SECRET,
].filter((s): s is string => !!s)

for (const secret of secrets) {
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, secret)
    lastErr = null
    break
  } catch (err) {
    lastErr = err
  }
}

if (!event) {
  console.error('Webhook signature failed:', lastErr)
  await logEvent({
    name: 'webhook_signature_invalid',
    properties: {
      sourceIp: req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? null,
      errorMessage: lastErr instanceof Error ? lastErr.message : String(lastErr),
    },
  })
  return new Response('Invalid signature', { status: 400 })
}
```

The rest of the handler (the `if (event.type === ...)` chain starting at
line 111) is unchanged.

### 2. [env.example](../env.example) — add one line

Add `STRIPE_PLATFORM_WEBHOOK_SECRET=` near the existing
`STRIPE_WEBHOOK_SECRET=` entry, so future devs know it exists. (The
broader env.example refresh is tracked separately in the launch runbook
and is out of scope here.)

## Edge cases handled

| Case | Behavior |
|---|---|
| `STRIPE_PLATFORM_WEBHOOK_SECRET` unset (e.g. local dev, preview before backfill) | `secrets` array contains only the Connect secret. Loop tries one secret. Identical to current behavior. |
| Both env vars unset | `secrets` is `[]`. Loop never runs. `event` is `undefined` → falls into the 400 path with `lastErr` still `null`. The error log message becomes `"null"` but the 400 status and log shape are preserved. (Existing behavior would have crashed on `process.env.STRIPE_WEBHOOK_SECRET!`'s non-null assertion — the new code is actually a slight improvement here.) |
| Connect webhook delivers event signed with Connect secret | First iteration verifies → break → handler proceeds. Same as today. |
| Platform webhook delivers event signed with platform secret | First iteration throws (signature mismatch) → second iteration verifies → break → handler proceeds. |
| Replay/forged event signed with an unknown secret | All iterations throw → `event` stays `undefined` → 400 + observability log fires. |
| Stripe rotates a secret out of band | Until env var is updated, that destination's events 400. Stripe retries for 3 days, so a 5-minute rotation window is fine. |

## Verification

### Pre-merge (on the branch)

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run` — all green (existing tests don't go through `constructEvent`, so should pass unchanged)
- [ ] Diff is exactly the block in §1 above plus the env.example line — no incidental edits

### Post-merge, pre-Stripe-destination-creation

- [ ] Vercel auto-deploy completes
- [ ] `curl -i -X POST https://winbackflow.co/api/stripe/webhook` still returns `400 Invalid signature` (regression check on the Connect secret path)
- [ ] No spike in `webhook_signature_invalid` events on `/admin/events` over the next 30 minutes (the existing Connect webhook should keep delivering successfully)

### Post-Stripe-destination-creation + env-var-set + redeploy

- [ ] In Stripe Dashboard, the new platform webhook destination's "Event deliveries" tab shows recent attempts as 200 (or 0 attempts if nothing has fired yet — fine on a fresh setup)
- [ ] When the first real merchant signs up + adds a card via the platform card-capture flow:
  - [ ] `wb_events` shows a `billing_card_captured` row
  - [ ] No `webhook_signature_invalid` row in the same time window
  - [ ] The merchant's row in `customers` has a non-null `stripeSubscriptionId`

## Rollout sequence (operational, not part of the merge)

After this spec is merged and deployed:

1. **Stripe Dashboard (live mode) → Webhooks → Add destination**
   - URL: `https://winbackflow.co/api/stripe/webhook`
   - **"Listen to events on Connected accounts"**: ⚠️ **OFF** (the critical toggle that distinguishes this from the existing Connect destination)
   - Events: `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.payment_succeeded`, `invoice.paid`
   - Save → reveal signing secret → copy `whsec_...`
2. `printf "%s" "whsec_..." | vercel env add STRIPE_PLATFORM_WEBHOOK_SECRET production`
3. `vercel --prod` (or push any commit) to redeploy with the new env var loaded
4. Run the post-creation verification checks above

## Branch + PR

- Branch name: `feat/spec-47-platform-webhook`
- PR title: `Spec 47: dual-secret webhook verification for platform-side events`
- PR description references this spec.

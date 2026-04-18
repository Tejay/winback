# Spec 20 — Reactivation flow improvements

**Phase:** Next up (April 2026)
**Depends on:** None (purely additive to `app/api/reactivate/[subscriberId]/route.ts`)

---

## Summary

Three improvements to the resubscribe flow, in order of effort:

| Phase | Change | Effort | Type |
|------|--------|--------|------|
| 20a | Detect active subscription, skip duplicate creation | Small | Bug fix |
| 20b | Meaningful failure page instead of generic "no worries" | Small | UX |
| 20c | Tier selection page when multiple plans are available | Medium | Feature |

Each phase is independently shippable. Land 20a + 20b together (both are
single-route changes); 20c on its own once you've decided whether to offer
tier choice.

---

## Context

The current reactivate route (`app/api/reactivate/[subscriberId]/route.ts`)
has three known weaknesses, observed during spec 19 test-harness work:

1. **Duplicate subscription bug.** If `subscription.cancel_at_period_end === false`
   on a retrieved subscription (i.e., the subscriber is currently active),
   neither branch of the resume check fires AND no error is thrown. The route
   falls through to Stage 2 and creates a brand-new Checkout session, which
   could result in two parallel subscriptions (double-billed).

2. **Silent failures.** Any error (deleted price, missing customer, Stripe
   API outage) redirects to `/welcome-back?recovered=false` with a generic
   "no worries, come back anytime" page. The subscriber has no way to know
   what went wrong, and the founder has no way to know either (only console
   logs catch it).

3. **No tier choice.** Subscribers always reactivate at their original price.
   If the founder has changed pricing, archived plans, or wants to upsell,
   there's no path. Subscribers can't downgrade if they cancelled because
   of price either.

---

## Phase 20a — Detect active subscription, don't duplicate

### What changes

**File:** `app/api/reactivate/[subscriberId]/route.ts`

After `subscriptions.retrieve()`, add an explicit check for already-active
status before falling through:

```ts
const sub = await stripe.subscriptions.retrieve(subscriber.stripeSubscriptionId)

if (sub.cancel_at_period_end === true) {
  // ... existing resume + recovery logic
} else if (sub.status === 'active' || sub.status === 'trialing') {
  // Already active — data drift, just correct our records and redirect.
  // Don't create a recovery (we didn't cause this) but mark them recovered.
  await db
    .update(churnedSubscribers)
    .set({ status: 'recovered', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, subscriberId))

  logEvent({
    name: 'reactivate_already_active',
    customerId: customer.id,
    properties: { subscriberId, stripeSubscriptionId: sub.id },
  })

  return NextResponse.redirect(`${baseUrl}/welcome-back?recovered=true`)
}
// else fall through to checkout (existing behavior)
```

### Why no recovery row

If the subscriber is already active without our help, we didn't cause
recovery — we just discovered our records were stale. Recording a recovery
would inflate metrics and (in the billing model) charge the customer for
revenue we didn't actually drive. The status update corrects the dashboard;
the event log captures it for visibility.

---

## Phase 20b — Meaningful failure page

### What changes

**File:** `app/api/reactivate/[subscriberId]/route.ts`

Replace blanket `?recovered=false` redirects with a specific reason:

```ts
return NextResponse.redirect(
  `${baseUrl}/welcome-back?recovered=false&reason=price_unavailable`
)
```

Reasons to support:
| Code | When it fires | Subscriber message |
|------|---------------|--------------------|
| `subscriber_not_found` | Bad/expired subscriberId in URL | "This link is no longer valid." |
| `account_disconnected` | Customer has no Stripe access token | "Reactivation is temporarily unavailable. Please contact us." |
| `price_unavailable` | Saved price was deleted, no fallback price | "The plan you had is no longer offered. Please contact us to set up a new subscription." |
| `checkout_failed` | Stripe API rejected Checkout creation | "Something went wrong on our end. Please try again or contact us." |
| (no reason) | Subscriber chose to cancel from Checkout | Existing "no worries" message |

**File:** `app/welcome-back/page.tsx`

Render contextual message + a contact link based on `searchParams.reason`:

```tsx
const messages: Record<string, { title: string; body: string }> = {
  price_unavailable: {
    title: "We've updated our plans",
    body: "The plan you were on isn't offered anymore. We'd love to find one that fits — drop us a line at hello@yourproduct.com",
  },
  account_disconnected: { ... },
  // etc.
}

const reason = searchParams.reason
const m = reason ? messages[reason] : null
```

Founder contact email comes from `customers.founderEmail` (would need to
look up by subscriber → customer). For now, hardcode a generic "contact us"
link or read from env.

### Bonus: log every failure

When falling into a failure branch, also `logEvent('reactivate_failed', { reason })`
so the founder can see in the dashboard how often reactivation breaks and why.

---

## Phase 20c — Tier selection page

### What changes

Today, clicking the resubscribe link goes either to:
- Resume (no choice)
- Checkout with the saved price (no choice)

After 20c, the route routes intelligently:

```
Click resubscribe link → /api/reactivate/[subscriberId]
   ├─ Can resume? → redirect to /welcome-back?recovered=true (no change)
   ├─ Single active price on connected account? → direct Checkout (no change)
   └─ Multiple active prices OR saved price changed? → redirect to /reactivate/[id]?t=token
```

### New page: `app/reactivate/[subscriberId]/page.tsx`

Server component. Token-protected (signed URL like unsubscribe — reuse
`generateUnsubscribeToken` pattern but for reactivation). Shows:
- Heading: "Welcome back, {firstName} — pick a plan"
- Their previous plan highlighted as "Your previous plan" (if still available)
- All other active recurring prices on the connected account
- A button per plan that POSTs to a new endpoint and redirects to Checkout
- A "no thanks, just take me back" link to `/welcome-back?recovered=false`

### New endpoint: `app/api/reactivate/[subscriberId]/checkout/route.ts`

```ts
POST /api/reactivate/[subscriberId]/checkout?t={token}
Body: { priceId: string }
```

Validates the token, validates the priceId belongs to the connected account,
creates a Checkout session, returns the URL (or 302 redirect). Same recovery
attribution flow as today.

### Token: reuse the unsubscribe-token pattern

`src/winback/lib/unsubscribe-token.ts` exports `generateUnsubscribeToken()`
which takes a subscriberId + secret and produces a signed token. Generalise
to `signSubscriberToken(subscriberId, purpose)` so the same machinery works
for unsubscribe AND reactivate (separate purposes prevent token reuse).

### Email link change

The reactivation link in emails stays as `/api/reactivate/[id]` — no change
needed. The route decides whether to redirect to Checkout or to the chooser
page. Backwards compatible.

### Routing logic in `app/api/reactivate/[subscriberId]/route.ts`

```ts
// After resume attempt fails:
const activePrices = await stripe.prices.list({ active: true, type: 'recurring', limit: 10 })

if (activePrices.data.length === 0) {
  return failureRedirect('price_unavailable')
}

// Auto-pick if there's only one option and it matches the saved price
if (activePrices.data.length === 1 && activePrices.data[0].id === subscriber.stripePriceId) {
  // Existing direct-Checkout path
  return checkoutRedirect(subscriber.stripePriceId, subscriber.stripeCustomerId)
}

// Otherwise show the chooser
const token = signSubscriberToken(subscriberId, 'reactivate')
return NextResponse.redirect(`${baseUrl}/reactivate/${subscriberId}?t=${token}`)
```

### What about price-aware suggestions?

A future enhancement (not in this spec): if the subscriber's
`cancellationCategory === 'Price'`, sort cheaper plans first or highlight
the cheapest option. Don't build that now — get the basic chooser shipped
first.

---

## Files to modify (full set across all phases)

| File | Phase | Change |
|------|-------|--------|
| `app/api/reactivate/[subscriberId]/route.ts` | all | Active-sub detection (20a), reason params (20b), chooser routing (20c) |
| `app/welcome-back/page.tsx` | 20b | Render contextual messages by `reason` |
| `app/reactivate/[subscriberId]/page.tsx` | 20c | **New** — tier chooser page (server component) |
| `app/api/reactivate/[subscriberId]/checkout/route.ts` | 20c | **New** — POST endpoint to create Checkout with chosen price |
| `src/winback/lib/unsubscribe-token.ts` | 20c | Generalise to `signSubscriberToken(id, purpose)` |
| `src/winback/__tests__/reactivate.test.ts` | all | **New** — unit tests for routing logic + token validation |

---

## Verification

### 20a
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` green
- [ ] Test: subscriber with `status: 'active'` sub clicks link → redirected to recovered=true, status flipped, **no recovery row inserted**, `reactivate_already_active` event logged
- [ ] Test: existing resume path (cancel_at_period_end=true) still works unchanged
- [ ] Test: existing fall-through-to-Checkout path still works unchanged

### 20b
- [ ] Test: subscriber doesn't exist → redirected with `reason=subscriber_not_found`, page shows clear message
- [ ] Test: customer has no token → redirected with `reason=account_disconnected`
- [ ] Test: Checkout creation fails → redirected with `reason=checkout_failed`
- [ ] Each failure logs `reactivate_failed` event with reason + subscriberId
- [ ] No-reason path (Checkout cancelled by subscriber) still shows "no worries"

### 20c
- [ ] Test (harness): seed a subscriber whose saved price was archived → click link → lands on chooser
- [ ] Test: click "your previous plan" button → goes to Checkout with that price
- [ ] Test: click a different plan → goes to Checkout with the chosen price → recovery records that price's mrrCents
- [ ] Test: invalid token → 400 (chooser page rejects)
- [ ] Test: priceId not on connected account → 400 (security — prevent arbitrary price injection)
- [ ] Single-price account: clicking link still bypasses chooser (no extra friction)
- [ ] End-to-end: post a real changelog with the harness, click the win-back email's resubscribe link, see chooser, pick a plan, complete Checkout

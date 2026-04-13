# Spec 08 — Activation Links + Attribution

**Phase:** 9
**Depends on:** Spec 04 (webhook handler, email sender), Spec 07 (billing)
**Estimated time:** 4 hours

---

## Overview

Every winback email includes a tracked reactivation link (Stripe Checkout session).
When a churned subscriber clicks the link and resubscribes, we attribute the recovery
to Winback with full proof — enabling billing.

Two attribution tiers:
- **Strong:** Subscriber used our checkout link (metadata proves it)
- **Weak:** Subscriber resubscribed organically after we emailed them (correlation within 12 months)

Both are billable. Dashboard shows which type each recovery is.

---

## Part A — Classification changes: only suppress when no email

**Current behaviour:** Tier 4 suppresses when email is null OR tenure < 5 days.
**New behaviour:** Only suppress when email is null. Everyone with an email gets at least one message.

Update `src/winback/lib/classifier.ts` system prompt:
```
Remove: "4 — Suppress. No email. Use when: email is null, tenure < 5 days, obvious test/spam account."
Replace: "4 — Suppress. No email. Use ONLY when: email is null. Every subscriber with an email should receive at least one message, regardless of tenure."
```

Status `lost` is now only set when:
- No email address (truly can't contact)

Remove the "Archive as lost" button from the dashboard detail panel. Founders don't need manual archiving — the system handles everything automatically.

---

## Part B — Recovery matching: all statuses except `recovered`

**Current:** `processRecovery` matches `status IN ('pending', 'contacted')`
**New:** `processRecovery` matches `status != 'recovered'`

In `app/api/stripe/webhook/route.ts`, update `processRecovery`:
```typescript
// Old
inArray(churnedSubscribers.status, ['pending', 'contacted'])

// New
not(eq(churnedSubscribers.status, 'recovered'))
```

This catches:
- `contacted` → we emailed them, they came back (expected)
- `pending` → we were about to email, they came back first (lucky)
- `lost` → we emailed them, founder archived, they came back anyway (surprise)

---

## Part C — Store price_id during signal extraction

Update `src/winback/lib/stripe.ts` `extractSignals`:
- Extract `price_id` from the cancelled subscription's first line item: `subscription.items.data[0].price.id`
- Add `stripePriceId` to the `SubscriberSignals` interface and `wb_churned_subscribers` table

**Migration `003_attribution.sql`** (add to existing migration in Part G):
```sql
ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
```

Store both the `price_id` (for checkout) and `subscription_id` (for resume check).

---

## Part D — Reactivation link in emails

Every email includes this link:
```
https://winbackflow.co/api/reactivate/{subscriberId}
```

**No pre-generated checkout sessions.** The link points to our own endpoint which generates a fresh Stripe session on click. This means:
- Links never expire
- No Stripe API call at email send time (faster, no failure mode)
- Same URL works forever — customer can click it weeks later

In `sendEmail`, the `reactivationLink` is always `${NEXT_PUBLIC_APP_URL}/api/reactivate/${subscriberId}`.

---

## Part E — Reactivation endpoint (handles everything on click)

New route: `app/api/reactivate/[subscriberId]/route.ts`

```typescript
export async function GET(req, { params }) {
  const { subscriberId } = await params
  // 1. Look up subscriber → customer → decrypt access token
  // 2. If already recovered → redirect to /welcome-back?recovered=true
  // 3. Try resume: if subscription still exists and cancel_at_period_end=true
  //    → resume it (set cancel_at_period_end=false)
  //    → create recovery record (attribution_type = 'strong')
  //    → redirect to /welcome-back?recovered=true
  // 4. Otherwise: create fresh Checkout session
  //    → customer sees their original plan + saved payment method
  //    → redirect customer to Stripe Checkout URL
}
```

**Step-by-step logic:**

**Step 1: Already recovered?**
```typescript
if (subscriber.status === 'recovered') {
  return redirect('/welcome-back?recovered=true')
}
```

**Step 2: Try resume (subscription not fully expired)**
```typescript
const stripe = new Stripe(decryptedAccessToken)
const sub = await stripe.subscriptions.retrieve(subscriber.stripeSubscriptionId)
if (sub.cancel_at_period_end === true) {
  await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false })
  // Create recovery record with attribution_type = 'strong'
  return redirect('/welcome-back?recovered=true')
}
```

**Step 3: Create fresh Checkout session (subscription fully expired)**
```typescript
const session = await stripe.checkout.sessions.create({
  mode: 'subscription',
  customer: subscriber.stripeCustomerId,
  line_items: [{ price: subscriber.stripePriceId, quantity: 1 }],
  success_url: `${NEXT_PUBLIC_APP_URL}/welcome-back?recovered=true`,
  cancel_url: `${NEXT_PUBLIC_APP_URL}/welcome-back?recovered=false`,
  metadata: {
    winback_subscriber_id: subscriberId,
    winback_customer_id: subscriber.customerId,
  },
})
return redirect(session.url)
```

Customer sees:
```
Pro Plan — £39/mo
Card: •••• 4242          ← already on file
[Subscribe]
```

One click. No typing. Saved payment method pre-filled.

**Step 4: Fallback**
If `stripePriceId` is null (legacy data), look up active prices on the connected account and use the first recurring price.
If Stripe call fails for any reason, redirect to `/welcome-back?recovered=false` with a message.

**Properties:**
- No auth required (link is in the email, customer clicks it)
- Idempotent — clicking twice is safe
- Links never expire — fresh session generated on every click
- Works for both resume and new checkout flows

---

## Part F — Append link to every email

Update `src/winback/lib/email.ts` `sendEmail`:

The `subscriberId` is already a parameter. Use it to build the reactivation link and append automatically:

```typescript
// Inside sendEmail, before sending:
const reactivationLink = `${process.env.NEXT_PUBLIC_APP_URL}/api/reactivate/${subscriberId}`

const fullBody = `${body}

Ready to give us another try? Resubscribe here:
${reactivationLink}

— ${fromName}`
```

**No changes needed in callers** — `sendEmail` already has `subscriberId`. The link is always appended. No Stripe API calls. No failure modes.

---

## Part G — Webhook: checkout.session.completed (strong attribution)

Add `checkout.session.completed` to the Connect webhook's enabled events.

Update webhook handler to process this event:

```typescript
if (event.type === 'checkout.session.completed') {
  await processCheckoutRecovery(event)
}
```

**`processCheckoutRecovery(event)`:**
1. Extract `session.metadata.winback_subscriber_id` and `winback_customer_id`
2. If no metadata → ignore (not a Winback checkout)
3. Look up subscriber in `wb_churned_subscribers`
4. If already `recovered` → ignore (idempotent)
5. Create `wb_recoveries` record with `attribution_type = 'strong'`
6. Update subscriber `status = 'recovered'`

---

## Part H — Update recovery matching for weak attribution

Update existing `processRecovery` (handles `customer.subscription.created`):

1. Match `status != 'recovered'`
2. Check if a `wb_emails_sent` record exists for this subscriber
3. If yes → create `wb_recoveries` with `attribution_type = 'weak'`
4. If no emails were ever sent → don't count as recovery (we didn't do anything)

---

## Part I — Database changes

**Migration `003_attribution.sql`:**
```sql
ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE wb_recoveries ADD COLUMN IF NOT EXISTS attribution_type TEXT DEFAULT 'weak';
-- 'strong' = clicked our checkout link or resume endpoint
-- 'weak' = resubscribed organically after we emailed them
```

**Schema update** in `lib/schema.ts`:
```typescript
// In recoveries table:
attributionType: text('attribution_type').default('weak'), // 'strong' | 'weak'
```

---

## Part J — Welcome back page

`app/welcome-back/page.tsx`

Simple static page, no auth required:
```
min-h-screen bg-[#f5f5f5] flex flex-col items-center justify-center
Logo centered
"Welcome back!" — text-2xl font-bold
"Thanks for giving us another try." — text-sm text-slate-500
```

Query param `?recovered=true` shows success state.
Query param `?recovered=false` shows "No worries, you can come back anytime."

---

## Part K — Dashboard: show attribution type

In the subscriber detail panel, when status is `recovered`:
- Strong: `"✓ Recovered — via Winback link"` (green badge)
- Weak: `"✓ Recovered — resubscribed organically"` (blue badge)

---

## Part L — Remove archive button + clean up cron

Remove "Archive as lost" button from dashboard subscriber detail panel.
Remove `POST /api/subscribers/[id]/archive` route.

Remove dead cron job from `vercel.json`:
```json
// Remove this — reply polling replaced by Resend inbound webhook
{
  "crons": [
    {
      "path": "/api/gmail/reply-poll",
      "schedule": "0 9 * * *"
    }
  ]
}
```

---

## Part M — Webhook events update

Update the Connect webhook on the platform to include the new event.
Run once (CLI or API):
```
POST /v1/webhook_endpoints/{id}
  enabled_events[]: customer.subscription.deleted
  enabled_events[]: customer.subscription.created
  enabled_events[]: checkout.session.completed     ← new
```

---

## Email trigger summary

| Trigger | When | Email type | Link included |
|---------|------|-----------|---------------|
| Cancellation | Webhook fires | `exit` | Yes |
| Changelog match | Founder updates changelog, keyword matches | `win_back` | Yes |
| Manual resend | Founder clicks "Resend" on dashboard | `followup` | Yes |

All emails go through `sendEmail` which handles link generation and appending.

---

## Definition of done
- [ ] Classifier only suppresses when email is null
- [ ] `processRecovery` matches all statuses except `recovered`
- [ ] `generateReactivationLink` creates Stripe Checkout session with metadata
- [ ] Every email includes a reactivation link (or gracefully omits if generation fails)
- [ ] `checkout.session.completed` webhook processes strong attribution
- [ ] `customer.subscription.created` webhook processes weak attribution
- [ ] `attribution_type` column in `wb_recoveries` (strong/weak)
- [ ] `stripe_price_id` and `stripe_subscription_id` stored during signal extraction
- [ ] Reactivation endpoint (`/api/reactivate/[subscriberId]`) handles:
  - Already recovered → redirect to welcome-back
  - Subscription resumable → resume + create recovery (strong)
  - Subscription expired → fresh checkout session → redirect to Stripe
  - Fallback if price missing → look up connected account prices
  - Stripe error → redirect to welcome-back with message
- [ ] Links never expire (generated on click, not at send time)
- [ ] Welcome back page renders correctly
- [ ] Dashboard shows attribution type on recovered subscribers
- [ ] "Archive as lost" button removed from dashboard
- [ ] Dead cron job removed from `vercel.json`
- [ ] Connect webhook updated with `checkout.session.completed` event
- [ ] Duplicate checkout handled (already recovered → redirect to welcome-back)
- [ ] All tests passing

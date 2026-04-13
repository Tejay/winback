# Spec 09 — Payment Failed Recovery (Dunning)

**Phase:** 10
**Depends on:** Spec 04 (webhook handler), Spec 08 (activation links, Resend email)
**Estimated time:** Half day

---

## Overview

When a subscriber's payment fails (expired card, insufficient funds, etc.), Winback
automatically sends a personalised email asking them to update their payment method.
This catches involuntary churn — customers who want to stay but have a billing issue.

Stripe fires `invoice.payment_failed` when a charge attempt fails. Stripe retries
automatically (up to 4 times over ~3 weeks). We only email on the **first** failure.
Most failed payments are recoverable — the customer just needs to update their card.

---

## Part A — Webhook: invoice.payment_failed

Add to the existing webhook handler in `app/api/stripe/webhook/route.ts`:

```typescript
if (event.type === 'invoice.payment_failed') {
  await processPaymentFailed(event)
}
if (event.type === 'invoice.payment_succeeded') {
  await processPaymentSucceeded(event)
}
```

**`processPaymentFailed(event)`:**
1. Extract `invoice` from event
2. Get `accountId` from `event.account` — find `wb_customers` row
3. If not found → ignore
4. Get `stripe_customer_id` from invoice (`invoice.customer`)
5. Get `subscription_id` from invoice (`invoice.subscription`)
6. If no subscription → ignore (one-time payment, not our scope)
7. **First attempt only:** Check `invoice.attempt_count` — if > 1, skip (already emailed)
8. **Idempotency:** Check `wb_emails_sent` for existing `type = 'dunning'` for this subscriber. If exists → skip
9. Look up or create subscriber in `wb_churned_subscribers`:
   - Check if this `stripe_customer_id` already exists for this customer
   - If not, create a record (no LLM classification needed):
     ```
     status: 'pending'
     cancellation_reason: 'Payment failed'
     cancellation_category: 'Other'
     tier: 2
     ```
   - Fetch customer email + name from Stripe API using access token
   - Store `payment_method_at_failure` = customer's current default payment method ID
10. Send dunning email via `sendDunningEmail`
11. Insert `wb_emails_sent` record with `type: 'dunning'`

---

## Part B — Dunning email sender

New function in `src/winback/lib/email.ts`:

```typescript
export async function sendDunningEmail(params: {
  subscriberId: string
  email: string
  customerName: string | null
  planName: string
  amountDue: number       // in cents
  currency: string
  nextRetryDate: Date | null
  fromName: string
}): Promise<void>
```

**Email content (first attempt, retry scheduled):**
```
Subject: Your payment didn't go through

Hi {customerName},

We tried to charge your card for {planName} ({amount}/{currency}) but it didn't
go through. This usually happens when a card expires or the bank declines it.

You can update your payment method here:
{NEXT_PUBLIC_APP_URL}/api/update-payment/{subscriberId}

We'll try again on {nextRetryDate} — updating before then means no interruption
to your service.

If you have any questions, just reply to this email.

— {fromName}
```

**Email content (final attempt, no retry):**
```
Subject: Action needed — your subscription is at risk

Hi {customerName},

This was our last attempt to charge your card for {planName} ({amount}/{currency}).
To keep your subscription active, please update your payment method:

{NEXT_PUBLIC_APP_URL}/api/update-payment/{subscriberId}

— {fromName}
```

The link goes through our endpoint (never expires, tracks clicks) rather than
a direct Stripe billing portal link (expires in 24 hours, no tracking).

---

## Part C — Update payment endpoint

New route: `app/api/update-payment/[subscriberId]/route.ts`

```typescript
export async function GET(req, { params }) {
  const { subscriberId } = await params
  // 1. Look up subscriber → customer → decrypt access token
  // 2. Record click: UPDATE wb_churned_subscribers SET billing_portal_clicked_at = NOW()
  // 3. Create Stripe billing portal session:
  //    stripe.billingPortal.sessions.create({
  //      customer: stripeCustomerId,
  //      return_url: NEXT_PUBLIC_APP_URL + '/welcome-back?recovered=true',
  //    })
  // 4. Redirect to session.url
}
```

Same pattern as `/api/reactivate/{subscriberId}`:
- No auth required (link is in the email, customer clicks it)
- Idempotent — clicking multiple times just creates new portal sessions
- Links never expire — fresh session generated on every click
- Each click updates `billing_portal_clicked_at` timestamp for attribution

---

## Part D — Recovery tracking with attribution

When `invoice.payment_succeeded` fires:

```typescript
async function processPaymentSucceeded(event) {
  // 1. Find subscriber by stripe_customer_id with cancellation_reason = 'Payment failed'
  //    and status != 'recovered'
  // 2. If not found → ignore (not a dunning case)

  // 3. Determine attribution:
  if (subscriber.billingPortalClickedAt) {
    // STRONG — they clicked our link to update their card
    attributionType = 'strong'
  } else {
    // Check if payment method changed since the failure
    const currentPM = customer.invoice_settings.default_payment_method
    if (currentPM !== subscriber.paymentMethodAtFailure) {
      // WEAK — card changed after our email (could be us, could be them)
      attributionType = 'weak'
    } else {
      // Same card, Stripe retry worked — we didn't help
      // Don't create recovery record
      return
    }
  }

  // 4. Create wb_recoveries record with attributionType
  // 5. Update subscriber status to 'recovered'
}
```

| Clicked our link | Payment method changed | Attribution | Recovery created |
|-----------------|----------------------|-------------|-----------------|
| ✅ Yes | Doesn't matter | **Strong** | Yes |
| ❌ No | ✅ Yes | **Weak** | Yes |
| ❌ No | ❌ No | Stripe retry | No |

---

## Part E — Database changes

**Migration `004_dunning.sql`:**
```sql
ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS billing_portal_clicked_at TIMESTAMPTZ;
ALTER TABLE wb_churned_subscribers ADD COLUMN IF NOT EXISTS payment_method_at_failure TEXT;
```

**Schema update** in `lib/schema.ts`:
```typescript
// In churnedSubscribers table:
billingPortalClickedAt: timestamp('billing_portal_clicked_at'),
paymentMethodAtFailure: text('payment_method_at_failure'),
```

No new tables. Uses existing `wb_churned_subscribers` and `wb_emails_sent`.

---

## Part F — Update Connect webhook events

Add both invoice events to the platform Connect webhook:

```
POST /v1/webhook_endpoints/{id}
  enabled_events[]:
    - customer.subscription.deleted
    - customer.subscription.created
    - checkout.session.completed
    - invoice.payment_failed          ← new
    - invoice.payment_succeeded       ← new
```

---

## Part G — Dashboard

Payment failed subscribers appear in the same dashboard table as churned subscribers.
No separate UI needed.

They show:
- Reason: "Payment failed"
- Status: `pending` → `recovered` (when payment succeeds with attribution)
- MRR: the invoice amount

---

## Email trigger summary (updated)

| Trigger | Stripe event | Email type | Link in email |
|---------|-------------|-----------|---------------|
| Cancellation | `customer.subscription.deleted` | `exit` | `/api/reactivate/{id}` |
| Changelog match | — (internal) | `win_back` | `/api/reactivate/{id}` |
| Manual resend | — (dashboard action) | `followup` | `/api/reactivate/{id}` |
| Payment failed | `invoice.payment_failed` | `dunning` | `/api/update-payment/{id}` |

---

## Definition of done
- [ ] `invoice.payment_failed` webhook handler processes first-attempt failures only
- [ ] Idempotent — duplicate webhooks don't send duplicate emails
- [ ] Email includes tracked billing portal link (`/api/update-payment/{subscriberId}`)
- [ ] Email tone varies: mentions next retry date if scheduled, urgency if final attempt
- [ ] `/api/update-payment/{subscriberId}` records click + redirects to Stripe billing portal
- [ ] `billing_portal_clicked_at` and `payment_method_at_failure` stored on subscriber
- [ ] `invoice.payment_succeeded` creates recovery with correct attribution (strong/weak/skip)
- [ ] Connect webhook updated with `invoice.payment_failed` + `invoice.payment_succeeded`
- [ ] Dashboard shows payment-failed subscribers alongside churned ones
- [ ] Tests passing

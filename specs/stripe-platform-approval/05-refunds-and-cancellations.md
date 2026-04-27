# 05 — Refunds & cancellations — give reviewers a single link

> **Status (2026-04-27):** Recommendation shipped — `/refunds` page is live.
> The example body in this spec describes the **original** 15% × 12-month
> pricing model. The pricing model has since been replaced by **\$99/mo
> platform fee + 1× MRR per win-back, refundable for 14 days** (see PRs
> [#33-#38] and [`app/refunds/page.tsx`](../../app/refunds/page.tsx) for the
> current copy that reviewers actually see). The Stripe-form refund-policy
> URL is unchanged.

Today the refund/cancellation story is scattered:

- `/terms` Section 3 implies it ("fees only apply to active recovered subscribers")
- `/faq` says "If we recover nothing, you pay nothing"
- `/pricing` says "Pay only when we recover"

A Stripe reviewer can't paste a single URL into the application form. Fix
that two ways.

## Option A (recommended) — dedicated `/refunds` page

Same shell as `/terms`. Single page, short and plain:

```markdown
## Winback fee structure and refunds

1. **When you are charged**
   Winback charges 15% of monthly revenue from recovered subscribers, for up
   to 12 months per subscriber. A recovery is recognised only when the
   previously-cancelled subscriber is actively paying you again on Stripe.

2. **When you are not charged**
   - You are never charged until Winback has recovered a real subscriber.
   - If a recovered subscriber cancels again, billing on that subscriber
     stops the same day.
   - After 12 months per recovered subscriber, billing on that subscriber
     ends permanently.
   - If you pause Winback, no new recoveries occur — existing attributed
     subscribers continue to bill until they cancel or hit their 12-month mark.

3. **Cancelling Winback**
   - Disconnect Stripe any time from Settings → Integrations, or from Stripe
     Dashboard → Apps.
   - Delete your Winback workspace from Settings → Danger Zone. Deletion is
     immediate and permanent (no grace period).
   - On workspace deletion: we cancel future billing immediately. Invoices
     already issued are still payable under the normal 30-day terms.

4. **Disputed charges**
   Email `support@winbackflow.co` within 30 days of the invoice. We review
   the attribution trail in Stripe and respond within 5 business days. If we
   can't show a legitimate attribution, we credit the disputed amount.

5. **Refunds for failed deliveries or bugs**
   If a Winback email was never sent, or was sent after the subscriber
   re-subscribed through a channel we didn't originate, we do not bill for
   that attribution. If we billed in error, we credit or refund — your
   choice.
```

Link `/refunds` from:
- Footer nav on `/`, `/pricing`, `/terms`, `/privacy`, `/dpa`, `/faq`, `/refunds` itself
- The Stripe application form → "Refund policy URL"

## Option B — add a labelled H3 inside `/terms`

Cheaper. Insert before the existing fee clause:

```
### 3.4 Refunds & cancellations
[same body as above, trimmed]
```

And point the Stripe form at `https://winbackflow.co/terms#refunds`. A fragment
link is acceptable; reviewers don't like it as much as a standalone URL.

## Recommendation

Go with Option A. It's ~60 lines of content, one React file, and it unblocks
future support conversations ("just send them /refunds"). It also makes the
`/settings` → `/settings/delete` flow easier to explain to the reviewer —
they can follow the narrative "cancel = delete workspace → billing stops →
`/refunds` explains the wind-down."

## File plan

Add:
- `app/refunds/page.tsx` — server component, identical shell to `/terms`
  (`bg-[#f5f5f5]`, rounded white card, `Refunds & cancellations.` title with
  the trailing period)
- `metadata: { title: 'Refunds & cancellations — Winback' }`

Modify:
- Landing + pricing footers to include `/refunds`
- `/terms` footer to include `/refunds`
- `/privacy` and `/dpa` footers likewise
- `/faq` under "Pricing & recovery": replace the "how is fee calculated"
  answer's plain-text aside with `[Full policy →](/refunds)`

## Verification

- [ ] `/refunds` renders and looks like the sibling legal pages
- [ ] All legal-page footers link to each other including `/refunds`
- [ ] Stripe application form "refund policy URL" field uses the standalone
      URL

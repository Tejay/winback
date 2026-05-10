# Spec 50 — Suppressed-subscriber override: helper UI, not a compose pipeline

> **Status (2026-05-10):** Pivoted. The original draft (committed at
> `8d42bc0`) proposed a full in-product compose modal + new `manual-send`
> route. Discussion landed on: that's the wrong shape. Merchants already
> have email tools that beat anything we'd build (their own context,
> drafts, signatures, threading, scheduled send). What Winback uniquely
> provides is the **signed reactivation URL** + the **subscriber's
> contact info** + **recovery attribution if they use that URL**. We
> don't need to be the email-send pipe.
>
> This spec now describes a much thinner "open in your email" helper
> (Option α below), and a stronger argument for **shipping nothing in
> v1** (Option β). Recommendation: β for launch, α only if real
> merchants surface the need post-launch.

## Context

When the AI classifier suppresses a churned subscriber (status =
`lost`), today there's no way for the merchant to override. The
existing **Resend** button is hidden for `lost` status, and even when
shown it replays a pre-generated AI message rather than letting the
merchant write something with their own context.

What we got wrong in the original spec 50: assumed the merchant wants
to compose *inside Winback*. They don't. Their inbox is where their
context lives — past correspondence, contact metadata, signatures, the
relationships. Building a compose UI inside Winback duplicates worse
versions of every email tool they already use.

What they actually need from us, in the rare case they want to override
a suppression:

1. The **signed reactivation URL** for that subscriber (otherwise the
   recipient has no one-click path back).
2. The subscriber's **email address** (Stripe also has this, but it's
   convenient to have it in the dashboard view they're already looking at).
3. A way to **mark the contact as initiated** so Winback can attribute
   the recovery if the subscriber comes back via the signed URL.

That's it. ~3 fields and a button. Not a compose pipeline.

## The two options

### Option α — "Open in your email" helper (small, deferrable)

Add a thin panel to the subscriber detail (visible for `lost` status,
optionally other non-recovered statuses) with:

- The recipient email + `[Copy]` button
- The signed reactivate URL + `[Copy]` button
- One-click `mailto:` opener that pre-fills `to=` and a sensible
  starter `subject` / `body` containing the reactivate URL
  (Gmail / Outlook compose URLs are also viable for users with web mail)
- A `[Mark as contacted]` button that calls a new lightweight endpoint
  (`POST /api/subscribers/[id]/external-contact`) which inserts a stub
  `wb_emails_sent` row with `type='manual_external'` and flips
  `status` from `lost` → `contacted`

Why the stub row: existing recovery attribution at
[app/api/stripe/webhook/route.ts:395-399](../app/api/stripe/webhook/route.ts#L395)
requires an `emails_sent` row to credit a recovery. Without the stub,
a merchant who emails from Gmail and recovers a subscriber gets no
attribution → no perf fee → Winback under-bills. The stub row lets
attribution work even though Winback didn't actually send the email.

Surface area: ~50 lines UI + ~30 lines endpoint + 1 unit test. No
sendEmail integration, no AI handoff semantics, no deliverability
surface, no schema changes (`'manual_external'` is unconstrained, same
as `'manual'`).

### Option β — Do nothing for v1 (recommended)

Merchants who really want to email a suppressed subscriber will figure
it out:

- They have the contact email in their Stripe Dashboard
- They can copy the subscriber's email from Winback's dashboard
- If they email from Gmail without using Winback's reactivate URL, they
  won't get attribution — but the recovery still happens, the merchant
  just doesn't owe a perf fee. Not a customer-facing problem.
- Most merchants won't bother — they signed up *because* they didn't
  want to compose win-back emails by hand

Risk of shipping nothing: zero. Worst case is "merchant emails
manually, subscriber resubscribes via merchant's website, Winback
doesn't track it." That's a missed billing event, not a broken UX.

Trigger to revisit: ≥3 merchants asking for it within 4 weeks of
launch, or visible signal in `/admin/events` that suppression rate is
high and merchants would want override.

## Goals

For Option α (if implemented):

- Merchant can copy the subscriber's email + signed reactivate URL from
  the dashboard with one click each.
- A `mailto:` (or Gmail/Outlook compose) link pre-fills enough that the
  merchant can be drafting in their own email client within 2 clicks.
- Recovery attribution works for merchant-sent external emails *if* the
  recipient clicks Winback's signed reactivate URL.
- No new email-send infrastructure inside Winback.

For Option β (default):

- Don't build it. Revisit if signal arrives.

## Non-goals (hard, regardless of option)

- **No compose UI inside Winback.** Original draft removed.
- **No `sendEmail` integration for merchant-authored copy.** Merchant
  uses their own email client, full stop.
- **No AI handoff / re-classification semantics for manual sends** —
  the question doesn't arise because Winback never sends the manual
  email. If the recipient replies, they reply to the merchant's own
  inbox, not via Winback's `reply+<id>@reply.winbackflow.co` route.
- **No template library, no draft saving, no compose history.** All of
  that lives in the merchant's email client.

## Code paths (Option α only — skip this section if going with β)

### 1. New API route — `app/api/subscribers/[id]/external-contact/route.ts`

```ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { logEvent } from '@/src/winback/lib/events'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.userId, session.user.id))
    .limit(1)
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
  }

  const [subscriber] = await db
    .select()
    .from(churnedSubscribers)
    .where(and(eq(churnedSubscribers.id, id), eq(churnedSubscribers.customerId, customer.id)))
    .limit(1)
  if (!subscriber) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }
  if (subscriber.status === 'recovered') {
    return NextResponse.json({ error: 'Already recovered' }, { status: 400 })
  }

  // Stub row so recovery attribution works if the subscriber re-subscribes
  // after the merchant's external email. No real Resend message ID.
  await db.insert(emailsSent).values({
    subscriberId: id,
    gmailMessageId: '',                  // empty — we never sent through Resend
    type: 'manual_external',
    subject: '[external — sent via merchant email client]',
    bodyText: null,                       // we don't know what they wrote
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, id))

  await logEvent({
    name: 'external_contact_marked',
    customerId: customer.id,
    userId: customer.userId,
    properties: { subscriberId: id },
  })

  return NextResponse.json({ success: true })
}
```

### 2. UI — `app/dashboard/dashboard-client.tsx`

Add an inline section to the subscriber detail panel (visible for
`status !== 'recovered'`, prominent for `status === 'lost'`):

- **Section header**: "Email them yourself"
- Email + Copy button
- Reactivate URL (rendered via `unsubscribeUrl`-style helper —
  actually the existing `reactivateUrl(subscriberId)` from email.ts:84) + Copy button
- Three buttons: `Open in Gmail`, `Open in Outlook`, `Open in mail app`
  - Each constructs a URL with `to=`, `subject=`, `body=` query params
  - Body includes a starter line + the reactivate URL
- `[Mark as contacted]` button — POSTs to `/api/subscribers/[id]/external-contact`,
  on success closes the section and refreshes the subscriber via SWR's `mutate`

The Gmail compose URL is `https://mail.google.com/mail/?view=cm&fs=1&to=...&su=...&body=...`.
The Outlook web URL is similar. Plain `mailto:` works as a universal fallback.

### 3. No schema migration

`emailsSent.type='manual_external'` is unconstrained (the unique-on-type
indexes in migrations 023, 028 only cover `'exit'`, `'dunning'`, etc.).

### 4. Attribution — no code change needed

[app/api/stripe/webhook/route.ts:395-399](../app/api/stripe/webhook/route.ts#L395)
already credits a recovery if **any** `emails_sent` row exists for the
subscriber. The stub row created above satisfies that. The 1× MRR perf
fee then charges normally if the subscriber resubscribes and clicks the
signed reactivate URL.

## Edge cases (Option α)

| Case | Behavior |
|---|---|
| Merchant clicks `[Mark as contacted]` without ever actually emailing | Stub row created; if subscriber later resubscribes (via the signed URL or otherwise), attribution counts. False-positive attribution is the merchant's choice. |
| Merchant clicks `[Mark as contacted]` twice | Two stub rows; harmless — `'manual_external'` is unconstrained. |
| Subscriber on DNC list | UI hides the panel for DNC subscribers (legal — we should not assist a merchant in re-contacting an unsubscribed user, even via their own client). The endpoint also rejects with 403. |
| Subscriber resubscribes without clicking the signed URL | No attribution. Same as today. |
| Status was already `contacted` (e.g., follow-up scenario) | Allowed — merchant can mark a second external contact. Multiple stub rows accumulate. |

## Verification (Option α)

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` green
- [ ] Unit test for the route: success, recovered status blocked, DNC blocked
- [ ] Manual click-through: dashboard → suppressed subscriber → Open in Gmail → confirm Gmail compose opens with the recipient/subject/body pre-filled
- [ ] After clicking `Mark as contacted`: subscriber status flips to `contacted`, stub row appears in `wb_emails_sent`

## Recommendation

**Ship β for launch.** Don't add this UI yet. The tradeoff:

- **Cost of β** = some merchants may email subscribers from their own client and we miss attribution (under-billing, not over-billing). Rare path. No customer-facing breakage.
- **Cost of α** = ~1 day of UI/backend/test work for a feature whose usage rate is unknown.

Revisit α post-launch if any of:
- ≥3 merchants explicitly request manual override
- A merchant churns Winback citing "your AI suppressed too aggressively and I had no override"
- `/admin/events` shows suppression rate >50% across merchants

If none of those happen in 4-6 weeks, you didn't need it.

## Branch + PR (Option α — only if approved later)

- Branch: `feat/spec-50-external-contact-helper`
- PR title: `Spec 50: external-contact helper for suppressed subscribers`

# Spec 50 — Suppressed-subscriber override: collapsible "open in your email" helper

> **Status (2026-05-10):** Pivoted from the original draft (committed at
> `8d42bc0`), which proposed a full in-product compose modal + new
> `manual-send` route. That was the wrong shape — merchants already
> have email tools that beat anything we'd build (their own context,
> drafts, signatures, threading, scheduled send). What Winback uniquely
> provides is the **signed reactivation URL** + the **subscriber's
> contact info** + **recovery attribution if they use that URL**. We
> don't need to be the email-send pipe.
>
> This spec describes a thin, collapsible "open in your email" helper:
> hidden behind a single-line disclosure for the common case (merchant
> accepts AI's suppression and moves on), with copy-buttons + three
> launch buttons (Gmail, Outlook, default mail app) + an
> attribution-stub endpoint when expanded. **Approved for launch.**
> Targeted scope <100 LoC.

## Context

When the AI classifier suppresses a churned subscriber (status =
`lost`), today there's no way for the merchant to override. The
existing **Resend** button is hidden for `lost` status
([app/dashboard/dashboard-client.tsx:1030](../app/dashboard/dashboard-client.tsx#L1030)),
and even when shown it replays a pre-generated AI message rather than
letting the merchant write something with their own context.

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
   convenient to have it in the dashboard view they're already looking
   at).
3. A way to **register the contact attempt** so Winback can attribute
   the recovery if the subscriber comes back via the signed URL —
   done transparently when they click any launch button so they
   can't forget.

That's it. ~3 fields, three launch buttons, one explicit fallback button.
Collapsed by default.

## Goals

- Merchant can, from the suppressed subscriber's drawer, copy the
  subscriber's email + signed reactivate URL with one click each.
- Three "Open in {client}" buttons cover the realistic spectrum of
  email clients merchants use:
  - **Open in Gmail** — opens `https://mail.google.com/mail/?view=cm&fs=1&to=...&su=...&body=...`
  - **Open in Outlook** — opens `https://outlook.live.com/mail/0/deeplink/compose?to=...&subject=...&body=...`
  - **Open in mail app** — opens `mailto:?to=...&subject=...&body=...`,
    routing to the user's OS-default email client (Apple Mail,
    Thunderbird, Spark, Hey, Superhuman, etc., or Gmail/Outlook if
    they've configured those as their default mailto handler)
- All three pre-fill the recipient + subject + body, with the body
  **prominently embedding the reactivate URL** so the subscriber
  clicks it (which is the attribution-clean path).
- Clicking any of the three launch buttons **also** silently registers
  the contact — fires `POST /api/subscribers/[id]/external-contact`
  as a side effect. This makes attribution robust to "merchant forgot
  to click Mark as contacted" (the most common real failure mode).
- A manual "Mark as contacted" fallback button — for merchants whose
  workflow doesn't fit any of the three launch buttons (e.g., they
  copied the fields, drafted in Notion first, then sent later).
- Recovery attribution works for merchant-sent external emails *if* the
  recipient clicks Winback's signed reactivate URL (already handled by
  the existing reactivate route — it inserts a `recoveries` row
  directly without consulting `emails_sent`).
- The whole section is **collapsed by default**: a single-line
  disclosure (`▸ Email them yourself`). Most merchants will accept the
  AI's suppression decision; the helper shouldn't visually clutter
  their dashboard.

## Non-goals

- **No compose UI inside Winback.** Original draft removed.
- **No `sendEmail` integration for merchant-authored copy.** Merchant
  uses their own email client, full stop.
- **No AI handoff / re-classification semantics for manual sends** —
  the question doesn't arise because Winback never sends the manual
  email. Replies go to the merchant's own inbox, not via Winback's
  `reply+<id>@reply.winbackflow.co` route.
- **No template library, no draft saving, no compose history.** All of
  that lives in the merchant's email client.
- **No client-detection / smart default.** All three launch buttons
  show for everyone; the merchant picks. Auto-detection is fragile
  (User-Agent, OS, etc. are unreliable signals for email-client
  preference) and not worth the complexity for a feature this small.

## Code paths

### 1. New API route — `app/api/subscribers/[id]/external-contact/route.ts`

```ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { isDoNotContact } from '@/src/winback/lib/email'
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
  if (await isDoNotContact(id)) {
    return NextResponse.json({ error: 'Subscriber has unsubscribed' }, { status: 403 })
  }

  // Stub row so recovery attribution works if the subscriber re-subscribes
  // after the merchant's external email. No real Resend message ID —
  // the email went through the merchant's own client.
  await db.insert(emailsSent).values({
    subscriberId: id,
    gmailMessageId: '',                  // empty — we never sent through Resend
    type: 'manual_external',
    subject: '[external — sent via merchant email client]',
    bodyText: null,                       // we don't know what they wrote
  })

  // Only flip lost → contacted; preserve other statuses so a follow-up
  // on a contacted sub doesn't regress.
  if (subscriber.status === 'lost') {
    await db
      .update(churnedSubscribers)
      .set({ status: 'contacted', updatedAt: new Date() })
      .where(eq(churnedSubscribers.id, id))
  }

  await logEvent({
    name: 'external_contact_marked',
    customerId: customer.id,
    userId: customer.userId,
    properties: { subscriberId: id, previousStatus: subscriber.status },
  })

  return NextResponse.json({ success: true })
}
```

### 2. UI — `app/dashboard/dashboard-client.tsx`

Add a **collapsible** inline section to the subscriber detail panel,
visible for `status === 'lost'` only (the suppressed case where the
merchant has no other override path). For other non-recovered
statuses, the existing Resend / Mark recovered actions cover the use
case.

#### Collapsed state (default)

A single-line disclosure row with a chevron, low visual weight:

```
▸ Email them yourself
```

#### Expanded state

```
▾ Email them yourself

  Have context the AI didn't? Email from your own inbox.

  TO
  testfounder.winback+sub1@gmail.com           [Copy]

  REACTIVATE LINK
  winbackflow.co/r/sub_AbC123XYZ                [Copy]
  Including this link in your email lets us credit
  the recovery if they come back.

  [ ▶ Open in Gmail ]  [ ▶ Open in Outlook ]  [ ✉ Open in mail app ]

  Used a different tool?
  [ ✓ Mark as contacted ]
```

#### Behavior details

- **Disclosure state**: local React state in the panel component.
  Not persisted across page reloads — the drawer is short-lived
  (closes when the user clicks out of the row), so persistence
  isn't useful.

- **Copy buttons**: clipboard copy with a 2-second "Copied!"
  feedback chip. Standard pattern.

- **Three launch buttons**:
  - **Open in Gmail** —
    `https://mail.google.com/mail/?view=cm&fs=1&to={to}&su={subject}&body={body}`,
    new tab.
  - **Open in Outlook** —
    `https://outlook.live.com/mail/0/deeplink/compose?to={to}&subject={subject}&body={body}`,
    new tab.
  - **Open in mail app** —
    `mailto:{to}?subject={subject}&body={body}`, routes to the
    user's OS default mailto handler (Apple Mail / Thunderbird /
    Spark / etc., or Gmail/Outlook web if user has configured
    them as their default).
  - All three URL-encode `subject` and `body` correctly (linebreaks
    as `%0A`).
  - **Auto-mark on click**: clicking any of the three buttons fires
    `POST /api/subscribers/[id]/external-contact` as a
    fire-and-forget side effect, then opens the compose URL.
    Rationale: the click is strong intent-to-send; auto-marking
    prevents the common "merchant forgot to click Mark as
    contacted" failure mode.
  - On 403 (DNC) the auto-mark fails silently — the section
    won't render for DNC subscribers anyway, so this is
    defense-in-depth.

- **Pre-filled body**:

  ```
  Hi {firstNameOrFallback},

  Saw you cancelled — wanted to reach out personally.

  [your message here]

  When you're ready, here's a one-click link to restart:
  → {reactivateUrl}

  – {merchantFromName}
  ```

  Putting the link inline (not just behind a copy button) sharply
  increases click-through, which is the attribution-clean path.

  - `firstNameOrFallback`: `subscriber.name?.split(' ')[0] ?? 'there'`
  - `merchantFromName`: `customer.founderName ?? session.user.name ?? 'The team'`
  - `reactivateUrl`: use the existing `reactivateUrl()` helper from
    [src/winback/lib/email.ts](../src/winback/lib/email.ts#L84) —
    already handles signing.

- **Manual "Mark as contacted"** — kept as a fallback for merchants
  whose workflow doesn't fit any of the three launch buttons (e.g.,
  copied the fields, drafted in Notion or a CRM first, then sent
  later). POSTs to the same endpoint. Auto-mark via the launch
  buttons makes this button the secondary path.

- **Auto-collapse on success**: after `external-contact` succeeds
  (whether triggered by a launch button or the explicit Mark as
  contacted), the section auto-collapses *and* the drawer
  re-renders the subscriber with the new `contacted` status. The
  section is no longer visible (because it only renders for
  `status === 'lost'`).

### 3. No schema migration

`emailsSent.type='manual_external'` is unconstrained — the
unique-on-type indexes in migrations 023 and 028 only cover `'exit'`,
`'dunning'`, `'win_back'`, `'dunning_t2'`, `'dunning_t3'`.

### 4. Attribution — no code change needed

[app/api/reactivate/[subscriberId]/route.ts:113-119](../app/api/reactivate/[subscriberId]/route.ts#L113)
already inserts a `recoveries` row directly when a subscriber clicks
the signed URL — it doesn't check `emails_sent` first. So even if the
merchant's external email is the only trigger, recovery attribution
works automatically when the subscriber clicks the embedded link.

The `emails_sent` stub row is a belt-and-braces signal that catches
the rare case where the subscriber resubscribes *without* clicking
the link (e.g., goes directly to the merchant's site instead).
Without the stub,
[app/api/stripe/webhook/route.ts:395-399](../app/api/stripe/webhook/route.ts#L395)
would skip recovery attribution for that subscriber.

## Edge cases

| Case | Behavior |
|---|---|
| Merchant clicks a launch button, doesn't actually send | Stub row created; status flipped to `contacted`. Cosmetic false-positive — merchant's dashboard says "contacted" when it wasn't. Real-world likelihood low; cost is purely visual. |
| Merchant clicks launch button, sends, recipient clicks reactivate link | Stub row exists; reactivate handler creates `recoveries` row directly; perf fee charges. ✅ Happy path. |
| Merchant clicks launch button, sends, recipient resubscribes via merchant's site (no link click) | Stub row exists from the auto-mark; webhook's `processRecovery` finds it and attributes. ✅ Robust to the "subscriber doesn't click link" failure mode. |
| Merchant uses some other email client (didn't click any launch button), clicks "Mark as contacted" | Stub row from manual button. ✅ |
| Merchant uses some other client, doesn't click "Mark as contacted" (forgot), recipient clicks reactivate link | Reactivate handler inserts `recoveries` row directly; perf fee charges. ✅ |
| Merchant uses some other client, doesn't click "Mark as contacted", recipient resubscribes outside the link | No stub row, no `emails_sent` row → no attribution. **The only real attribution miss.** Acceptable: merchant didn't use any of Winback's flow, hard to fairly attribute. |
| Merchant clicks Mark as contacted twice / multiple launch buttons | Multiple stub rows accumulate (`'manual_external'` is unconstrained). Harmless. |
| `mailto:` does nothing (no default handler set) | The other two buttons + the manual fallback cover this case. Some merchants might be confused for ~5 seconds before trying another button. Acceptable. |
| Subscriber on DNC list (unsubscribed) | UI hides the entire section + replaces with `"This subscriber has unsubscribed."` notice. Endpoint also rejects with 403. Legal — we should not assist a merchant in re-contacting an unsubscribed user. |
| Status was `pending` or `contacted` (not `lost`) | Section doesn't render. The existing Resend / Mark recovered buttons cover those flows. |
| Pre-filled body too long for compose URL | Gmail/Outlook web URL limits are generous (~30k chars). `mailto:` body limits vary but ~2000 chars is safe across major clients. Our body is ~250 chars. Non-issue. |

## Verification

### Pre-merge (on branch)

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green (existing 505 tests unchanged)
- [ ] New unit test for the route: `src/winback/__tests__/external-contact.test.ts`
  - success path on `lost` subscriber → row inserted, status flipped
  - success path on `contacted` subscriber → row inserted, status preserved
  - `recovered` status → 400
  - DNC → 403
  - Unauthorized → 401
  - Customer-scoped: route rejects 404 if subscriber belongs to a
    different customer

### Post-merge smoke

- [ ] Pick a `lost` subscriber in the dashboard (the `C2` row from
      the smoke test works)
- [ ] Verify the disclosure starts collapsed (`▸ Email them yourself`)
- [ ] Click the disclosure → expanded panel shows email, reactivate
      URL, three launch buttons, fallback button
- [ ] Click `[Copy]` on email → clipboard contains the address
- [ ] Click `[Copy]` on reactivate URL → clipboard contains the
      URL; visiting it in a browser triggers the reactivate flow
- [ ] Click `[ ▶ Open in Gmail ]` →
  - New tab opens at Gmail compose with `to`, `subject`, `body`
    pre-filled
  - Body contains the reactivate URL inline
  - Behind the scenes: a `wb_emails_sent` row appears with
    `type='manual_external'`
  - Subscriber status flips `lost` → `contacted`
  - Drawer re-renders, section is hidden
- [ ] Repeat for `[ ▶ Open in Outlook ]` and `[ ✉ Open in mail app ]`
      against fresh `lost` subscribers
- [ ] On a fresh `lost` subscriber, expand the section, click
      `[ ✓ Mark as contacted ]` directly → same DB effects

### Observability after deploy

- [ ] `/admin/events` filter on `external_contact_marked` to gauge
      usage. Low or zero usage in the first month → confirms most
      merchants accept the AI's suppression. High usage → signal
      worth investigating (maybe the AI is suppressing too
      aggressively).

## Branch + PR

- Branch: `feat/spec-50-external-contact-helper`
- PR title: `Spec 50: external-contact helper for suppressed subscribers`

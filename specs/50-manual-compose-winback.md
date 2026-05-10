# Spec 50 — Manual compose: merchant-authored win-back emails

## Context

Today, when the LLM classifier suppresses a churned subscriber (status =
`lost`), the merchant has no way to override the decision. The existing
**Resend** button at
[app/dashboard/dashboard-client.tsx:1030-1037](../app/dashboard/dashboard-client.tsx#L1030)
is conditionally hidden for `lost` subscribers, and even when shown it
replays a pre-generated AI message rather than letting the merchant
write one.

The conversation around suppression (Spec 49 retro) surfaced two real
asymmetries:

1. **The classifier suppresses precisely when there's no signal** — so any
   "force-classify" path produces low-quality filler (the failure mode
   suppression was protecting against).
2. **When a merchant legitimately wants to override, they have
   out-of-band context** — they recognize the customer, know a relevant
   feature shipped, or want to write a personal note. The right way to
   capture that context is to let them write.

But pure free-form composition is hand-grenade UX without the
reactivation link, unsubscribe footer, and threading metadata. **The
system should auto-append all of that machinery so the merchant just
writes the personalized portion.**

This spec adds a "Compose manual email" action to the subscriber detail
panel. It is **not** general-purpose merchant→subscriber messaging — it
is specifically for the case where the merchant wants to override the
AI's decision (or follow up with new context) for a single subscriber.

## Goals

- Merchant can compose and send a custom win-back email from the
  subscriber detail panel, for any subscriber except `recovered`.
- The subject line is merchant-authored.
- The body is merchant-authored, with the standard reactivation link +
  unsubscribe footer auto-appended on send (using the existing
  `appendStandardFooter`).
- Hard gates preserved:
  - **DNC** — if the subscriber unsubscribed, manual send is blocked
    (legal compliance, not a setting the merchant can override).
  - **Auth** — only the workspace owner can send.
- Soft gates bypassed (the merchant explicitly clicked "send"):
  - **Customer-paused** — manual sends bypass the workspace pause. The
    pause is for *automated* AI sends; this is a deliberate one-off.
  - **AI-paused for subscriber** — same reasoning.
- Status updates: subscriber status flips to `contacted` after a
  successful manual send (consistent with automated `scheduleExitEmail`
  behavior).
- Audit trail: a row in `wb_emails_sent` with `type = 'manual'`,
  preserving the full body for `/admin/subscribers/[id]` rendering.
- Observability: emit `email_sent` event with `emailType: 'manual'` for
  `/admin/events`.

## Non-goals

- **No general inbox or messaging UI** — single-shot compose only, no
  reply threading from this UI (replies still flow through the existing
  inbound webhook path).
- **No AI-drafted starting copy.** The textarea is blank. Loading an
  AI-generated draft in the suppressed case is precisely the path we're
  rejecting (see Context). Could be added later as the v2 hybrid I
  mentioned in chat, but not now.
- **No rich-text editor.** Plain text textarea, monospace, identical to
  what AI sends (the existing emails are plain-text). HTML is out of
  scope; if/when we add HTML elsewhere, can revisit.
- **No bulk compose** — one subscriber at a time.
- **No template library.** v1 ships without saved templates.
- **No prefill from `winBackBody`.** Even for non-suppressed subs, the
  textarea starts blank. Prefilling could undermine the "merchant brings
  context" framing — they'd just send the AI's message verbatim, which
  the existing Resend button already does.
- **No new schema fields.** We use the existing `wb_emails_sent` table
  with the new `type='manual'` (which is unconstrained per migrations
  023 and 028 — those constraints apply only to `'exit'`, `'dunning'`,
  `'win_back'`, `'dunning_t2'`, `'dunning_t3'`).

## Code paths touched

### 1. New API route — `app/api/subscribers/[id]/manual-send/route.ts`

```ts
import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { customers, churnedSubscribers, emailsSent } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { z } from 'zod'
import {
  sendEmail,
  appendStandardFooter,
  isDoNotContact,
} from '@/src/winback/lib/email'
import { logEvent } from '@/src/winback/lib/events'

const InputSchema = z.object({
  subject: z.string().trim().min(1, 'Subject required').max(200),
  body: z.string().trim().min(10, 'Body too short').max(5000),
})

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const parsed = InputSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }
  const { subject, body } = parsed.data

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
  if (!subscriber || !subscriber.email) {
    return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 })
  }
  if (subscriber.status === 'recovered') {
    return NextResponse.json({ error: 'Already recovered' }, { status: 400 })
  }

  // Hard gate: legal/compliance — never bypassable.
  if (await isDoNotContact(id)) {
    return NextResponse.json({ error: 'Subscriber has unsubscribed' }, { status: 403 })
  }

  const fromName = customer.founderName ?? session.user.name ?? 'The team'

  const { messageId } = await sendEmail({
    to: subscriber.email,
    subject,
    body,
    fromName,
    subscriberId: id,
  })
  if (!messageId) {
    // sendEmail returns empty messageId only on DNC short-circuit; we pre-checked, so this would be a race. Defensive 500.
    return NextResponse.json({ error: 'Send failed' }, { status: 500 })
  }

  // Persist the actual rendered body (with footer) so /admin/subscribers/[id]
  // renders the conversation as the recipient saw it.
  const fullBody = appendStandardFooter(body, id, fromName)

  await db.insert(emailsSent).values({
    subscriberId: id,
    gmailMessageId: messageId,
    type: 'manual',
    subject,
    bodyText: fullBody,
  })

  await db
    .update(churnedSubscribers)
    .set({ status: 'contacted', updatedAt: new Date() })
    .where(eq(churnedSubscribers.id, id))

  await logEvent({
    name: 'email_sent',
    customerId: customer.id,
    userId: customer.userId,
    properties: { subscriberId: id, emailType: 'manual', subject, messageId },
  })

  return NextResponse.json({ success: true })
}
```

Notes:
- `sendEmail` already does its own DNC check internally + appends footer. We pre-check DNC for a clean 403 instead of a silent no-op, and we re-append-footer separately for `bodyText` storage (same pattern as `scheduleExitEmail` at email.ts:373).
- We bypass customer-pause and AI-pause guards intentionally (per Goals). `sendEmail` itself doesn't check those — only `scheduleExitEmail` does — so calling `sendEmail` directly is the right primitive.

### 2. UI — `app/dashboard/dashboard-client.tsx`

Add a new dialog component (keep it inline in the same file since it's simple enough). Add a "Compose manual email" button to the action area of the subscriber detail panel, visible for all statuses **except `recovered`**. Specifically:

- For `lost` (suppressed) subscribers, this is currently the only available action.
- For `pending` / `contacted`, it sits alongside Resend and Mark recovered as a third action.

UI shape:

```
[Compose manual email]   ← opens dialog

Dialog:
  ┌─ Compose email to <subscriber.email> ─────────────────┐
  │                                                       │
  │ ⓘ The AI suppressed this send. Make sure you have     │   (only shown if status === 'lost')
  │   context the AI didn't — e.g., a personal note or    │
  │   a relevant feature you've shipped.                  │
  │                                                       │
  │ Subject: [______________________________________]     │
  │                                                       │
  │ Body:                                                 │
  │ ┌─────────────────────────────────────────────────┐   │
  │ │                                                 │   │
  │ │ (textarea — 8 rows minimum, monospace)         │   │
  │ │                                                 │   │
  │ └─────────────────────────────────────────────────┘   │
  │                                                       │
  │ ⓘ A reactivate link and unsubscribe footer will be    │
  │   automatically appended.                             │
  │                                                       │
  │ [Cancel]                                  [Send →]    │
  └───────────────────────────────────────────────────────┘
```

Implementation details:
- New local state: `composeOpen: boolean`, `composeSubject: string`, `composeBody: string`, `composeSending: boolean`, `composeError: string | null`.
- `handleManualSend` posts to `/api/subscribers/${id}/manual-send`, on success closes dialog, refreshes subscriber data via the existing `mutate()` from SWR, and shows a brief success toast (or just re-renders the panel with `status='contacted'`).
- On 403 (DNC), surface the error message inline in the dialog.
- Disable Send button when subject empty, body < 10 chars, or `composeSending`.
- No live preview of the appended footer in v1 — the inline ⓘ note is enough. Keeps the UI simple. Could add a "preview" toggle in v2.

### 3. No schema migration

`emailsSent` schema accepts arbitrary `type` text values. The two unique-constraint migrations (023, 028) explicitly scope to specific automated types and don't touch `'manual'`.

## Edge cases handled

| Case | Behavior |
|---|---|
| Subscriber on DNC list | `isDoNotContact` → 403 with explicit error in dialog |
| Subscriber `recovered` | UI hides the button; route returns 400 if called directly |
| Workspace paused (`customers.paused_at` set) | Send proceeds — manual sends bypass workspace pause (intentional, see Goals) |
| AI paused for subscriber (`ai_paused_until`) | Send proceeds — same reason |
| Already manually-sent before | Allowed — `'manual'` type has no unique constraint, multiple sends OK |
| Subject empty / body < 10 chars | Zod validation → 400, surfaced in dialog |
| Body > 5000 chars | Zod 400. Real win-back emails are well under 1000 chars; 5000 is generous. |
| Resend API throws | `sendEmail` retry wrapper handles transient; persistent failure bubbles as 500 |
| Concurrent double-click | UI disables Send while in-flight; backend has no idempotency key so two real concurrent posts would send twice. Acceptable risk for v1 — frontend gate is sufficient. |
| Invalid subscriber ID | Customer-scoped query returns no row → 404 |

## Verification

### Pre-merge (on branch)

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green (existing 505 tests unchanged)
- [ ] New unit test for the route: mock `sendEmail`, `isDoNotContact`, `db`. Cover (a) success path, (b) DNC blocked, (c) recovered status blocked, (d) Zod validation 400. ~30 lines in `src/winback/__tests__/manual-send.test.ts`.

### Post-merge smoke

- [ ] Pick the existing suppressed `C2` subscriber from last night's smoke test — has email populated, status = `lost`
- [ ] Click "Compose manual email"
- [ ] Type a real-looking subject + body
- [ ] Send
- [ ] Confirm:
  - [ ] Email arrives at `testfounder.winback+sub1@gmail.com` with the typed body + appended reactivate button + unsubscribe footer
  - [ ] Subscriber row's status flips to `contacted`
  - [ ] `wb_emails_sent` has a new row with `type='manual'` and full body
  - [ ] `/admin/events` shows `email_sent` with `emailType: 'manual'`

### Observability after deploy

- [ ] Watch `/admin/events` for `email_sent` rows where `emailType='manual'` to gauge actual usage
- [ ] If usage is high, that's the signal to invest in v2 (AI-drafted hybrid, templates, etc.)

## Branch + PR

- Branch: `feat/spec-50-manual-compose-winback`
- PR title: `Spec 50: manual compose for win-back emails`

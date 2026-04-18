# Spec 21 — Conversation continuity + founder handoff

**Phase:** Next up (April 2026)
**Depends on:** Spec 17 (outcome events), Spec 18 (evidence-based attribution)

---

## Summary

Engaged subscribers (those who replied at least once) currently receive the
same neglect as silent ones once the AI runs out of follow-ups. Two improvements:

| Phase | Change | Effort |
|------|--------|--------|
| 21a | Proactive nudge for engaged-but-silent + earlier backstop for engaged subscribers | Small |
| 21b | Founder handoff state, richer notification with mailto, 30-day strong-attribution window | Medium |
| 21c | Notification email setting + dashboard snooze button | Small |

Each phase ships independently. 21a is mechanical (cron extension + one
column). 21b changes attribution logic and the notification email design,
so it's worth landing alone for clean review.

---

## Context

`sendReplyEmail()` only fires when an inbound reply arrives. After 2 follow-ups
(`MAX_FOLLOWUPS = 2`), a thin notification email goes to the founder and the
AI stops. But:

- If a subscriber replies, we send a follow-up, and they go silent → **nothing
  happens.** No nudge, no founder alert. The conversation just dies.
- The 90-day re-engagement cron treats engaged and silent subscribers identically,
  even though they're entirely different cohorts.
- The handoff notification email today gives the founder almost no context to act on.
- If the founder takes over and the subscriber resubscribes 30 days later via the
  founder's outreach, evidence-based attribution (spec 18) marks it `organic` →
  not billable. Winback did the orchestration work but gets $0 credit.

The fix has two layers: **keep the conversation alive while the AI is involved**
(21a), then **make the handoff smooth and preserve attribution** when the AI
hands off to a human (21b).

---

## Phase 21a — Proactive nudge + engaged backstop

### Schema change

Add one column for "when did this subscriber last engage with us" (reply,
portal click, etc.):

```sql
ALTER TABLE wb_churned_subscribers
  ADD COLUMN last_engagement_at TIMESTAMPTZ;
```

Backfill from existing data:
```sql
UPDATE wb_churned_subscribers
  SET last_engagement_at = COALESCE(
    (SELECT MAX(replied_at) FROM wb_emails_sent WHERE subscriber_id = wb_churned_subscribers.id),
    billing_portal_clicked_at
  );
```

Drizzle:
```ts
lastEngagementAt: timestamp('last_engagement_at'),
```

### Where to set it

| Trigger | File | When |
|---------|------|------|
| Subscriber replies | `app/api/email/inbound/route.ts` | After saving `replyText`, before re-classification |
| Subscriber clicks reactivation link | `app/api/reactivate/[subscriberId]/route.ts` | At the top of the route, after subscriber lookup |
| Subscriber clicks billing portal link | `app/api/update-payment/[subscriberId]/route.ts` | Already sets `billingPortalClickedAt` — also set `lastEngagementAt` |

Add to each: `set({ lastEngagementAt: new Date(), ... })`.

### Proactive nudge

A new branch in the existing reengagement cron (`app/api/cron/reengagement/route.ts`).

After the existing 90-day query, run a second query for engaged-but-silent
subscribers:

```ts
const engagedNudgeCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 7 days

const engagedCandidates = await db
  .select()
  .from(churnedSubscribers)
  .where(
    and(
      inArray(churnedSubscribers.status, ['contacted']),
      eq(churnedSubscribers.doNotContact, false),
      isNotNull(churnedSubscribers.email),
      isNotNull(churnedSubscribers.lastEngagementAt),
      // 7+ days since their last engagement
      lte(churnedSubscribers.lastEngagementAt, engagedNudgeCutoff),
      // Has not been handed off
      isNull(churnedSubscribers.founderHandoffAt),  // (added in 21b — null check is forward-compatible)
      // Hasn't already been nudged proactively
      isNull(churnedSubscribers.proactiveNudgeAt),
    )
  )
  .limit(50)
```

Add column for tracking the nudge:
```sql
ALTER TABLE wb_churned_subscribers
  ADD COLUMN proactive_nudge_at TIMESTAMPTZ;
```

For each engaged candidate:
- Check follow-up count from `emailsSent` (must be < `MAX_FOLLOWUPS - 1` to leave room for one more)
- Re-classify with current state
- Send via `sendReplyEmail()` (threaded, counts as a `followup` type)
- Set `proactiveNudgeAt = now()` so we don't nudge twice
- Log `proactive_nudge_sent` event

### Earlier backstop for engaged subscribers

The existing 90-day backstop query continues to fire for everyone, but engaged
subscribers can ALSO be eligible earlier via the new nudge query. The two queries
don't conflict — they target different states (`proactive_nudge_at IS NULL` for
the nudge, `reengagement_count < 1` for the 90-day backstop).

Net effect: engaged subscribers may get a nudge at day ~7-14 AND the
90-day re-engagement, while silent subscribers only get the 90-day attempt.

### Files to modify (21a)

| File | Change |
|------|--------|
| `src/winback/migrations/013_engagement_continuity.sql` | **New** — add `last_engagement_at`, `proactive_nudge_at` columns + backfill |
| `lib/schema.ts` | Add the two columns |
| `app/api/email/inbound/route.ts` | Set `lastEngagementAt` on reply |
| `app/api/reactivate/[subscriberId]/route.ts` | Set `lastEngagementAt` at top |
| `app/api/update-payment/[subscriberId]/route.ts` | Set `lastEngagementAt` alongside `billingPortalClickedAt` |
| `app/api/cron/reengagement/route.ts` | New engaged-nudge query + send loop |
| `src/winback/__tests__/reengagement.test.ts` | Add tests for nudge eligibility logic |

---

## Phase 21b — Founder handoff state + attribution preservation

### Schema change

```sql
ALTER TABLE wb_churned_subscribers
  ADD COLUMN founder_handoff_at TIMESTAMPTZ,
  ADD COLUMN founder_handoff_resolved_at TIMESTAMPTZ;
```

Drizzle:
```ts
founderHandoffAt: timestamp('founder_handoff_at'),
founderHandoffResolvedAt: timestamp('founder_handoff_resolved_at'),
```

`founderHandoffAt` set when the AI exhausts MAX_FOLLOWUPS and the notification
fires. `founderHandoffResolvedAt` set when subscriber is recovered, lost, or
unsubscribed.

### State semantics

| State | Meaning | Auto-emails fire? |
|-------|---------|-------------------|
| `founderHandoffAt IS NULL` | AI is still in charge | Yes (exit, follow-up, nudge, changelog match, 90-day backstop) |
| `founderHandoffAt IS NOT NULL`, `resolvedAt IS NULL` | Handed off to founder, awaiting outcome | **No** — all automated sends skip these subscribers |
| `founderHandoffResolvedAt IS NOT NULL` | Conversation closed (recovered / lost / unsubscribed) | No (terminal state) |

Add `AND founder_handoff_at IS NULL` to:
- Reengagement cron candidate query (both 90-day and engaged-nudge branches)
- Changelog match candidate query (`app/api/changelog/route.ts`)
- `sendReplyEmail()` early-return guard if handoff has happened (defensive)

### Where handoff is triggered

Already exists in `sendReplyEmail()` when `MAX_FOLLOWUPS` is reached
(see `src/winback/lib/email.ts` ~line 200). Today it just emails the founder
and returns. Update it to also:

```ts
await db
  .update(churnedSubscribers)
  .set({ founderHandoffAt: new Date(), updatedAt: new Date() })
  .where(eq(churnedSubscribers.id, subscriberId))

logEvent({
  name: 'founder_handoff_triggered',
  customerId: customer.id,
  properties: { subscriberId, reason: 'max_followups_reached' },
})
```

Future trigger (defer): proactive nudge from 21a goes silent → handoff after
14 days. For now, only `MAX_FOLLOWUPS` triggers handoff.

### Richer notification email

Today's email is a thin one-liner. Replace with a structured handoff that
gives the founder everything they need:

**File:** `src/winback/lib/founder-handoff-email.ts` (new)

Exports `buildHandoffEmail({ subscriber, customer, conversation })` returning
`{ subject, body, mailtoLink }`.

**Content:**

```
Subject: [Winback] Action needed — Sarah Smith (Feature: CSV export)

Hi {founderName},

{subscriber} replied to your win-back email and the AI follow-ups have been
exhausted. They're worth a personal touch.

──────────────────────────────────────
SUBSCRIBER
{name} — {email}
Plan: {planName} (${mrr}/mo)
Cancelled: {daysAgo} days ago
Reason: {cancellationReason}
What they need: {triggerNeed}
──────────────────────────────────────

CONVERSATION HISTORY:

[Day 0] You sent exit email
"{firstMessage.body}"

[Day {n}] {Subscriber} replied
"{replyText}"

[Day {n}] AI follow-up
"{followupBody}"

[Day {n}] AI nudge — no further reply
"{nudgeBody}"

──────────────────────────────────────

→ REPLY TO {firstName}: {mailtoUrl}

(opens your email client with the conversation pre-quoted +
your reactivation link included)

→ View full details: {dashboardUrl}
```

**`mailtoUrl` construction:**

```
mailto:{email}?subject=Re: About your subscription&body=
Hi {firstName},

[your message here]

When you're ready to come back, here's your direct link:
{reactivationUrl}

—
{founderName}

> [Day {n}] {nudgeBody}
> [Day {n}] {followupBody}
> [Day {n}] {their reply}
> [Day {n}] {original exit email}
```

(URL-encoded, of course.)

This delivers everything in one click for the founder: their default email
client opens, To/Subject/Body all pre-filled, conversation quoted, reactivation
link embedded. Founder writes 1-3 sentences and hits send.

### Attribution: 30-day handoff window

This is the key change. Without it, founder-driven recoveries get marked
`organic` and Winback gets no billing credit.

**File:** `app/api/stripe/webhook/route.ts` — modify `processRecovery()`,
`processCheckoutRecovery()` (already strong, no change needed), and
`processPaymentSucceeded()`.

Add at the top of the attribution-determination block:

```ts
const HANDOFF_ATTRIBUTION_DAYS = 30

if (churned.founderHandoffAt) {
  const daysSinceHandoff = Math.floor(
    (Date.now() - churned.founderHandoffAt.getTime()) / (1000 * 60 * 60 * 24)
  )
  if (daysSinceHandoff <= HANDOFF_ATTRIBUTION_DAYS) {
    attributionType = 'strong'
    // Skip evidence-based checks — handoff window is the strongest signal
  }
}

// ... existing evidence-based checks if attributionType not set
```

**Reasoning:** When Winback explicitly hands off to the founder, the founder
couldn't have known to reach out without our orchestration. Any recovery
within 30 days is causally ours. Past 30 days, fall back to spec 18's
evidence-based logic.

Also set `founderHandoffResolvedAt = now()` in all recovery paths if the
subscriber was in handoff state. Same for the unsubscribe routes.

### Behavior after handoff

After handoff, **automated outbound stops**, but subscriber events still surface
to the founder for awareness:

| Event | Pre-handoff | Post-handoff |
|-------|-------------|--------------|
| Reply received | Auto re-classify + send follow-up | 🔔 **Notify founder** of new reply (don't auto-reply) |
| Changelog match would have fired | Auto-send win-back email | 🔔 **Notify founder**: "We shipped X, Sarah asked — want to mention it?" |
| Reactivation link clicked | Resume / Checkout → strong recovery | Same — also marks `founderHandoffResolvedAt` |
| Unsubscribed | DNC set | Same — also marks `founderHandoffResolvedAt` |
| 90-day backstop / engaged nudge | Fires automatically | Skipped |

The handoff state hands the entire conversation to the founder, but Winback
keeps watching and routes any new signal to them.

### Dashboard surface

- Add a "Founder action needed" section to the dashboard subscriber list:
  rows where `founderHandoffAt IS NOT NULL AND founderHandoffResolvedAt IS NULL`
- Surface the conversation thread + mailto button on the subscriber detail page

### Files to modify (21b)

| File | Change |
|------|--------|
| `src/winback/migrations/014_founder_handoff.sql` | **New** — add `founder_handoff_at`, `founder_handoff_resolved_at` |
| `lib/schema.ts` | Add the two columns |
| `src/winback/lib/email.ts` | `sendReplyEmail()` sets `founderHandoffAt` when MAX_FOLLOWUPS hit; replace inline notification with `buildHandoffEmail()` call |
| `src/winback/lib/founder-handoff-email.ts` | **New** — build the rich notification + mailto |
| `app/api/cron/reengagement/route.ts` | Filter out `founderHandoffAt IS NOT NULL` |
| `app/api/changelog/route.ts` | Filter out `founderHandoffAt IS NOT NULL` |
| `app/api/stripe/webhook/route.ts` | Add 30-day handoff attribution window in `processRecovery()` and `processPaymentSucceeded()`; set `founderHandoffResolvedAt` on recovery |
| `app/api/reactivate/[subscriberId]/route.ts` | Set `founderHandoffResolvedAt` on resume / Checkout completion path |
| `app/api/unsubscribe/[subscriberId]/route.ts` | Set `founderHandoffResolvedAt` |
| `src/winback/__tests__/founder-handoff.test.ts` | **New** — tests for handoff state, mailto building, attribution window logic |
| `src/winback/__tests__/attribution.test.ts` | Add cases for handoff-window strong attribution |

---

---

## Phase 21c — Notification email setting + snooze

Two related controls for managing handoff notifications.

### Notification email

Today, all founder notifications go to the user's signin email. Many founders
want these routed to a team inbox (`team@company.com`) or a dedicated address.

**Schema:**
```sql
ALTER TABLE wb_customers ADD COLUMN notification_email TEXT;
```

Drizzle:
```ts
notificationEmail: text('notification_email'),
```

**Resolution helper** in `src/winback/lib/email.ts`:
```ts
export async function resolveFounderNotificationEmail(customerId: string): Promise<string | null> {
  const [row] = await db
    .select({
      notificationEmail: customers.notificationEmail,
      userEmail: users.email,
    })
    .from(customers)
    .innerJoin(users, eq(customers.userId, users.id))
    .where(eq(customers.id, customerId))
    .limit(1)
  return row?.notificationEmail ?? row?.userEmail ?? null
}
```

Use this in **every** founder notification path:
- Existing `MAX_FOLLOWUPS` notification in `sendReplyEmail()`
- Handoff notification (21b)
- Reply-after-handoff notification (21b)
- Changelog-match-after-handoff notification (21b)

**Settings UI** (`app/settings/page.tsx`):

Add a new field to the existing settings form:
- Label: "Notification email"
- Helper text: "Where we send handoff alerts and subscriber updates. Defaults to your signin email if blank."
- Type: email input, optional
- Save via existing settings API or new `PATCH /api/settings/notification-email`

### Snooze

When the founder gets a handoff and needs a break (vacation, busy week), they
should be able to snooze notifications for that subscriber.

**Schema:**
```sql
ALTER TABLE wb_churned_subscribers ADD COLUMN founder_handoff_snoozed_until TIMESTAMPTZ;
```

Drizzle:
```ts
founderHandoffSnoozedUntil: timestamp('founder_handoff_snoozed_until'),
```

**Behavior:**
- When `founderHandoffSnoozedUntil > now()`: skip ALL post-handoff notifications
  (reply notifications, changelog match notifications)
- Handoff state itself doesn't change — automated emails still skip
- When snooze expires, future events resume notifying. **No backlog dump** —
  events that happened during snooze are visible in the dashboard but don't
  trigger emails after the fact.

**Dashboard UI:**

On the subscriber detail page (or handoff list), add buttons:
- `Snooze 1 day`
- `Snooze 1 week`
- `Mark resolved` (sets `founderHandoffResolvedAt`)

POST to a new endpoint:
```
POST /api/subscribers/[id]/handoff
Body: { action: 'snooze' | 'resolve', durationDays?: number }
```

Auth: standard session check. Verify subscriber belongs to the customer.

### Files to modify (21c)

| File | Change |
|------|--------|
| `src/winback/migrations/015_notifications_snooze.sql` | **New** — add `notification_email` to customers, `founder_handoff_snoozed_until` to subscribers |
| `lib/schema.ts` | Add the two columns |
| `src/winback/lib/email.ts` | Add `resolveFounderNotificationEmail()` helper, use it in `sendReplyEmail()` notification path |
| `src/winback/lib/founder-handoff-email.ts` | Use `resolveFounderNotificationEmail()` for recipient |
| All notification senders (handoff, reply-after-handoff, changelog-after-handoff) | Check `founderHandoffSnoozedUntil` before sending |
| `app/settings/page.tsx` | Add notification email field to settings form |
| `app/api/settings/notification-email/route.ts` | **New** — PATCH endpoint (or wire into existing settings PATCH) |
| `app/api/subscribers/[id]/handoff/route.ts` | **New** — POST endpoint for snooze / resolve |
| `app/dashboard/page.tsx` (or subscriber detail) | Add snooze + resolve buttons for handed-off subscribers |
| `src/winback/__tests__/founder-handoff.test.ts` | Add tests for notification email resolution + snooze logic |

---

## Verification

### 21a
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` green
- [ ] Migration applied; existing engaged subs backfilled with `lastEngagementAt`
- [ ] Test (mocked): subscriber replied 8 days ago, no further activity → eligible for nudge → nudge sent + `proactiveNudgeAt` set
- [ ] Test: subscriber replied 8 days ago BUT was nudged already → not re-eligible
- [ ] Test: subscriber replied 8 days ago AND already at MAX_FOLLOWUPS → handoff path instead (defer to 21b for actual handoff)
- [ ] Manual: post a reply via inbound webhook simulator, advance time, run cron → nudge fires

### 21b
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` green
- [ ] Migration applied
- [ ] Test: subscriber hits MAX_FOLLOWUPS → `founderHandoffAt` set, notification fires with rich content + working mailto link
- [ ] Test: subscriber in handoff state → reengagement cron skips them
- [ ] Test: subscriber in handoff state → changelog match skips them
- [ ] Test: recovery within 30 days of handoff → strong attribution (overrides evidence-based)
- [ ] Test: recovery 35 days after handoff → falls back to evidence-based (probably organic)
- [ ] Test: any recovery path sets `founderHandoffResolvedAt` correctly
- [ ] Manual: trigger a handoff in dev, open the email, click the mailto, verify pre-composed message looks right
- [ ] Manual: simulate a `subscription.created` after handoff, verify strong attribution recorded

### 21c
- [ ] Migration applied
- [ ] Test: customer with `notification_email` set → notifications go there, not to user signin email
- [ ] Test: customer without `notification_email` → falls back to user.email
- [ ] Test: snoozed subscriber → reply arrives → reply text saved, `founderHandoffSnoozedUntil` respected, no notification sent
- [ ] Test: snooze expires → next event triggers notification
- [ ] Test: "Mark resolved" sets `founderHandoffResolvedAt`
- [ ] UI: settings page shows notification email field, saves on submit
- [ ] UI: dashboard shows handoff section with snooze + resolve buttons

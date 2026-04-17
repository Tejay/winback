# Spec 17 — Instrument email lifecycle outcomes in wb_events

**Phase:** Next up (April 2026)
**Depends on:** Spec 14 (wb_events table + logEvent helper)

---

## Summary

`wb_events` currently only logs onboarding funnel events (OAuth redirect, completed,
denied). Every email lifecycle event — sent, replied, clicked, recovered, unsubscribed —
happens in code but is NOT logged to `wb_events`. This means:

- No way to query "how many emails did we send last week"
- No conversion funnel from email → reply → recovery
- No unsubscribe rate tracking
- No data to feed back into the classifier (future cohort learning)

All of these events already happen and are tracked in their own tables (`emailsSent`,
`recoveries`, `churnedSubscribers`). The fix is adding `logEvent()` calls at each
point. No schema changes, no new tables, no new routes — just instrumentation.

---

## Events to add

### 1. `email_sent`

**Where:** `src/winback/lib/email.ts` — after successful send in `sendEmail()` (line ~100)

**Why in sendEmail():** All email types flow through this function. One instrumentation
point covers exit, followup, dunning, win_back, and reengagement.

**Properties:**
```ts
{
  subscriberId,
  emailType,     // caller passes this — 'exit' | 'followup' | 'dunning' | 'win_back' | 'reengagement'
  subject,
  messageId,
}
```

**Change:** Add `emailType` parameter to `sendEmail()`, or add `logEvent()` in each
caller (`scheduleExitEmail`, `sendReplyEmail`, `sendDunningEmail`, cron route, changelog
route) after the `sendEmail()` call returns. Second approach is better — keeps
`sendEmail()` focused on sending, callers log with their context.

**Recommended: log in callers, not in sendEmail().** Each caller knows the `emailType`
and `customerId`. `sendEmail()` doesn't know `customerId`.

Files to modify:
- `src/winback/lib/email.ts` — `scheduleExitEmail()`, `sendReplyEmail()`, `sendDunningEmail()`
- `app/api/cron/reengagement/route.ts` — after sendEmail
- `app/api/changelog/route.ts` — after sendEmail

### 2. `email_replied`

**Where:** `app/api/email/inbound/route.ts` — after saving reply text (line ~60)

**Properties:**
```ts
{
  subscriberId,
  replyTextLength: replyText.length,
}
```

### 3. `link_clicked`

**Where:** Two locations:

a) `app/api/update-payment/[subscriberId]/route.ts` — billing portal click (line ~36)
```ts
{ subscriberId, linkType: 'billing_portal' }
```

b) `app/api/reactivate/[subscriberId]/route.ts` — reactivation link click (line ~45)
```ts
{ subscriberId, linkType: 'reactivate' }
```

**Note:** Merge `email_clicked` and `portal_opened` into a single `link_clicked`
event with a `linkType` property. Simpler to query, same data.

### 4. `subscriber_recovered`

**Where:** Three recovery paths in `app/api/stripe/webhook/route.ts`:

a) `processRecovery()` — after inserting recovery (line ~215)
b) `processCheckoutRecovery()` — after inserting recovery (line ~252)
c) `processPaymentSucceeded()` — after inserting recovery (line ~461)

Also: `app/api/reactivate/[subscriberId]/route.ts` — resume path (line ~65)

**Properties:**
```ts
{
  subscriberId,
  attributionType,    // 'strong' | 'weak'
  planMrrCents,
  recoveryMethod,     // 'subscription_created' | 'checkout' | 'payment_succeeded' | 'reactivate_resume'
}
```

### 5. `subscriber_unsubscribed`

**Where:** `app/api/unsubscribe/[subscriberId]/route.ts` — both GET (line ~22) and
POST (line ~41) handlers

**Properties:**
```ts
{
  subscriberId,
  method: 'html' | 'one_click',  // GET = html link, POST = List-Unsubscribe-Post
}
```

---

## Getting customerId for logEvent

Most of these routes don't have the `customerId` readily available. Options:

1. **Query it:** `SELECT customer_id FROM wb_churned_subscribers WHERE id = subscriberId`
   — one extra query, but `logEvent()` swallows errors so it won't break flow.
2. **Pass it through:** Some callers already have it (email.ts functions, webhook route).
3. **Allow null:** `logEvent()` already accepts `customerId: null`. For link clicks
   and unsubscribes (no auth session), log without customerId — it's in the properties
   via `subscriberId` and can be joined later.

**Recommendation:** Pass `customerId` when available (email callers, webhook). Use
`subscriberId` in properties for routes that don't have it (unsubscribe, reactivate).
Don't add an extra DB query just for telemetry.

---

## Files to modify

| File | Events added |
|------|-------------|
| `src/winback/lib/email.ts` | `email_sent` in `scheduleExitEmail()`, `sendReplyEmail()`, `sendDunningEmail()` |
| `app/api/cron/reengagement/route.ts` | `email_sent` after send |
| `app/api/changelog/route.ts` | `email_sent` after send |
| `app/api/email/inbound/route.ts` | `email_replied` |
| `app/api/update-payment/[subscriberId]/route.ts` | `link_clicked` (billing_portal) |
| `app/api/reactivate/[subscriberId]/route.ts` | `link_clicked` (reactivate) |
| `app/api/stripe/webhook/route.ts` | `subscriber_recovered` (3 paths) |
| `app/api/unsubscribe/[subscriberId]/route.ts` | `subscriber_unsubscribed` |

All changes are additive `logEvent()` calls. No schema changes, no new dependencies.

---

## Verification

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run` — all tests green
- [ ] Send a test exit email → check `wb_events` for `email_sent` row
- [ ] Reply to test email → check for `email_replied` row
- [ ] Click reactivation link → check for `link_clicked` row
- [ ] Trigger a recovery → check for `subscriber_recovered` row
- [ ] Click unsubscribe → check for `subscriber_unsubscribed` row
- [ ] Existing flows unaffected (logEvent swallows errors)

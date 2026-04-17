# Spec 15 — Signal sources fix: reply text, reply response, billing portal click

**Phase:** In progress (April 2026)
**Depends on:** Spec 03 (classifier + email), Spec 14 (telemetry)
**Fixes:** Two broken promises on the landing page, one signal gap

---

## Summary

The AI engine design audit (see `docs/ai-engine-design.html`) found three
issues in the signal-sources layer — the data we feed the classifier:

1. **Reply text never reaches the LLM.** `classifier.ts:145` hardcodes
   `reply_text: not_provided`. The inbound route stores the reply in
   `subscriber.replyText` and re-invokes the classifier, but the reply
   content is excluded from the prompt. The re-classification runs on
   identical signals and produces the same result.

2. **Re-classified email is never sent.** After re-classification, new
   `winBackSubject` and `winBackBody` are written to the DB but no code
   sends them. The subscriber replies, we silently re-classify, and
   nothing visible happens.

3. **Billing portal click not fed to AI.** `billingPortalClickedAt` is
   tracked in the DB but never included in the signals passed to the
   classifier. A subscriber who clicked the portal but didn't complete
   is high-intent — the AI should know this.

Together, these break the landing-page promise: *"When a subscriber
replies, the same AI reads it — new context flows back in and tunes the
next move."*

---

## What changes

### Modified

| File | Change |
|------|--------|
| `src/winback/lib/types.ts` | Add `replyText` and `billingPortalClicked` to `SubscriberSignals` |
| `src/winback/lib/classifier.ts` | `buildPrompt()` now interpolates `signals.replyText` instead of hardcoding `not_provided`; adds `billing_portal_clicked` signal; system prompt updated with re-classification rules |
| `app/api/email/inbound/route.ts` | Passes `replyText` and `billingPortalClicked` in signals; calls `sendReplyEmail()` after re-classification |
| `src/winback/lib/email.ts` | New `sendReplyEmail()` function — sends follow-up in the same thread using `In-Reply-To` / `References` headers |
| `src/winback/__tests__/classifier.test.ts` | New tests: reply_text included in prompt, billing_portal_clicked included in prompt |
| `docs/ai-engine-design.html` | Updated status badges for fixed nodes |

### Unchanged

- `app/api/stripe/webhook/route.ts` — initial classification still works; new fields are optional with sensible defaults
- `src/winback/lib/email.ts` `sendEmail()` / `scheduleExitEmail()` / `sendDunningEmail()` — untouched
- Schema — no migration needed; `replyText` column already exists in `wb_churned_subscribers`

---

## Design decisions

### 1. Reply text is the highest-signal input on re-classification

The system prompt now includes explicit rules for when `reply_text` is
present: treat it as a re-classification, read the reply as the primary
signal, re-assess tier and reason, and generate a new `firstMessage`
that directly responds to what the subscriber said.

This means the same `classifySubscriber()` function handles both initial
classification (reply_text absent) and re-classification (reply_text
present). No new LLM call shape, no new function — just better input.

### 2. Follow-up email threads using In-Reply-To

`sendReplyEmail()` looks up the original `emailsSent` row for the
subscriber to get the Resend message ID. It sets `In-Reply-To` and
`References` headers so email clients thread the reply correctly.

The email type is `'followup'` — distinct from `'exit'`, `'dunning'`,
and `'win_back'`. This makes it easy to query follow-up outcomes
separately.

### 3. Billing portal click as a boolean signal

Rather than passing a timestamp, we pass a boolean
`billingPortalClicked`. The LLM doesn't need to reason about *when* the
click happened — just that it did. This keeps the prompt clean and the
signal unambiguous: "this person tried to reactivate and didn't finish."

---

## Verification

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run` — all tests green
- [ ] Classifier tests confirm `reply_text` and `billing_portal_clicked` appear in the prompt
- [ ] Existing cancellation flow unaffected (new fields default correctly)

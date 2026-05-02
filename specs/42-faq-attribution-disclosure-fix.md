# Spec 42 — FAQ attribution disclosure fix

**Phase:** Public-facing accuracy fix
**Depends on:** Spec 18 (attribution model), Spec 21b (handoff
strong-attribution window), Spec 22a (proactive-pause
strong-attribution window)
**Estimated time:** ~30 min, copy-only

---

## Context

The FAQ pricing section currently claims the only billable trigger
for the 1× MRR performance fee is a clicked reactivate link in our
email. The actual billing logic in
[app/api/stripe/webhook/route.ts:392–435](app/api/stripe/webhook/route.ts:392)
fires `'strong'` attribution (which is the gate for the performance
fee) on **any** of:

1. Click on our reactivate link (`billingPortalClickedAt`)
2. Reply to our email (`recentEmail.repliedAt`)
3. **Founder handoff within the last 30 days** (Spec 21b — AI escalated
   the case to the founder; if the customer comes back inside the
   window, Winback gets credit)
4. **Proactive AI pause within the last 30 days** (Spec 22a — founder
   paused the AI to handle this customer themselves; same logic)

A merchant who reads the current FAQ ("we only bill on a click") and
then sees a `1× MRR` line item for a customer they personally won back
via a handoff reply has every right to feel mislead. This is a
billing-disclosure accuracy issue, not just a copy polish.

The fix is FAQ-only — no behavior change, no schema, no API, no
migration. Same code paths fire the same fees as today; we're just
describing them honestly.

## Goals

- Rewrite the "What counts as a win-back?" answer to enumerate all
  four billing triggers.
- Rewrite "What if someone reactivates without clicking our email?"
  so it no longer claims blanket "no click = no bill."
- Add a new explicit Q&A about handoff billing — the most surprising
  case for merchants.
- Keep the underlying principle intact: every invoice has a
  verifiable trigger behind it (handoff/pause/reply/click are all
  verifiable database states).

## Non-goals

- **Changing what we bill for.** The code is correct; the FAQ is
  wrong. Same fees fire on the same triggers as today.
- **Pricing-page copy rewrite.** Different surface, different review
  cadence. Sweep in a follow-up if needed.
- **In-product disclosure** (a tooltip on the dashboard saying
  "this recovery was attributed because…"). Future spec.
- **Changelog email** announcing the clarification. Out of scope of
  this spec; flag to founder separately.

## What changes

### A. Rewrite "What counts as a win-back?"

Replace the current single-trigger answer:

> A subscriber who actively cancelled on Stripe, then clicked the
> reactivate link in our email and resumed their subscription. We can
> prove the click, so we bill the one-time fee. Payment recoveries
> (when we save a failed-payment subscription) are different — those
> are covered by the platform fee, no separate charge.

with a tighter four-trigger enumeration:

> A subscriber comes back after we engaged with them. Specifically,
> one of:
>
> - They clicked our reactivate link.
> - They replied to our email.
> - They came back within 30 days of us escalating to you (a "handoff").
> - They came back within 30 days of you pausing our AI for them.
>
> Payment recoveries are billed separately — covered by the $99/mo
> platform fee.

(Earlier draft had a longer intro and an explanatory closing
paragraph; both dropped per founder review for clarity. The bullet
text already says enough.)

### B. Rewrite "What if someone reactivates without clicking our email?"

Replace the existing single-paragraph answer with a positively-framed
version that splits organic vs weak into bullets and reframes the
dashboard-vs-billing reconciliation:

> No bill if we did nothing. That covers:
>
> - **Organic** — they came back on their own. No email engagement,
>   no handoff, no pause.
> - **Weak** — we sent an email but they didn't click, didn't reply,
>   and we didn't escalate.
>
> Both still count as recoveries in your dashboard — that's the full
> picture of what came back. The fee fires only when we can point to
> a verifiable trigger (click, reply, handoff, or pause).

(Earlier draft used "show up as recovered but don't trigger the
fee" — reframed to emphasize the dashboard is the honest tally and
the fee is the subset Winback drove. Avoids reading like fine
print.)

### C. Add a new question — "If I personally write back to a customer Winback handed off to me, who earns the fee?"

Insert as a new entry in the "Pricing & recovery" section, right
after "What counts as a win-back?":

> The fee covers detection and surfacing, not the reply. Our AI
> catches the cancellation, classifies why, and gets the case in
> front of you fast — without that, the customer would've been just
> another quiet churn in your Stripe dashboard. The conversation you
> have with them is yours; we're charging for the pipeline that made
> that conversation possible.
>
> Same logic when you pause our AI to handle a subscriber yourself.

(Two earlier-draft phrases dropped per founder review:
"not the keystrokes of the reply you sent" and "the work we charge
for is the triage layer." Both edged toward claiming credit for the
founder's reply. New lead sentence — "covers detection and
surfacing, not the reply" — is the explicit disclaimer.)

## Critical files

| Path | Change |
|---|---|
| `specs/42-faq-attribution-disclosure-fix.md` | **new** (this file) |
| `app/faq/page.tsx` | Three Q&A edits in the "Pricing & recovery" section (rewrite two existing, add one new) |
| `app/refunds/page.tsx` | One paragraph rewritten — the legal-adjacent refunds doc was making the same "clicks the reactivate link" claim and needed the same fix. Found via the grep audit in §Verification. |

No other files. No tests (FAQ is content). No schema. No env vars.

## Edge cases

1. **Other pages that mention "click" as the trigger.** `/pricing`,
   `/landing`, anything in the dashboard. Audit with a quick grep
   during implementation; fix any found ones in this PR if they're
   one-line tweaks, otherwise file a follow-up.
2. **Existing pilot/early customers** — may have read the old FAQ
   and built an inaccurate mental model. Worth a short notice
   ("we've clarified the FAQ on what triggers the performance fee —
   no change to billing, but the language was incomplete"). NOT in
   scope of this spec but flag to founder before this lands in prod.
3. **`/dpa` and `/terms`** — billing terms in the legal docs already
   reference the correct triggers (verified during Spec 22a). No
   changes needed there. Re-verify during implementation just in
   case.

## Verification

- [ ] `npx tsc --noEmit` clean (FAQ is .tsx — type errors caught at
      build)
- [ ] Manual click-through on `/faq`:
  - [ ] "What counts as a win-back?" answer lists all four triggers
  - [ ] "What if someone reactivates without clicking?" no longer
        claims blanket "we never bill"
  - [ ] New "If I personally write back…" Q appears right after
        "What counts as a win-back?"
- [ ] Cross-reference: every trigger in the FAQ matches a branch in
      `app/api/stripe/webhook/route.ts:392–435`
- [ ] No other pages currently claim "we only bill on a click":
      ```
      grep -rn "tracked click\|only bill\|click on our\|reactivat.*link" \
        app/ components/ --include='*.tsx'
      ```

## Out of scope (future)

- Pricing-page rewrite to match the broader trigger set.
- In-product attribution disclosure (a "why was I billed for this?"
  panel on the dashboard subscriber drawer).
- Changelog/email announcement of the FAQ clarification.
- Comprehensive audit of merchant-facing copy across the site for
  similar inaccuracies.

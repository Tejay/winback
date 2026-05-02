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

with the four-trigger enumeration:

> A subscriber Winback brought back through work we did. We bill the
> performance fee on any one of these triggers:
>
> - They clicked the reactivate link in our email.
> - They replied to our email (we engaged them, even if they didn't click).
> - They came back within 30 days of us escalating their case to you (a
>   "handoff" — our AI decided your personal touch would be more
>   effective than another automated email).
> - They came back within 30 days of you pausing our AI for them (you
>   took over the conversation).
>
> In all four cases, Winback did the work that led to the recovery —
> classification, escalation, draft replies, or surfacing the lost
> customer to your inbox. Payment recoveries (when we save a
> failed-payment subscription) are different — those are covered by
> the $99/mo platform fee, no separate charge.

### B. Rewrite "What if someone reactivates without clicking our email?"

Replace:

> We don't bill for it. Maybe our email nudged them indirectly, maybe
> not — but "we sent an email and something happened" isn't proof.
> The win-back fee only fires when there's a tracked click on our
> reactivation link, so every invoice has a verifiable trigger behind
> it.

with:

> We don't bill for **organic** recoveries — no email engagement, no
> handoff, no pause, the customer just came back on their own. Same
> for "weak" cases: we sent an email, the customer didn't click,
> didn't reply, and we didn't escalate to you. Both show up in your
> dashboard as "recovered" but don't trigger the performance fee.
> Every invoice has a verifiable trigger behind it (click, reply,
> handoff, or pause), so you can always trace back why we billed.

### C. Add a new question — "If I personally write back to a customer Winback handed off to me, who earns the fee?"

Insert as a new entry in the "Pricing & recovery" section, right
after "What counts as a win-back?":

> Winback. The handoff itself is the work we charge for — our AI
> classified the cancellation, decided your personal touch would be
> more effective than another automated email, and surfaced the
> customer to your inbox with the context. Without that escalation
> you might never have known to reach out. The performance fee
> covers that triage layer. Same when you proactively pause our AI
> on a subscriber: if they come back within 30 days, that's
> Winback-attributed.

(Note: an earlier draft had a phrase "not the keystrokes of the
reply you sent" — explicitly dropped per founder review. The
positive framing of what Winback does is more durable than
contrasting with what the founder does.)

## Critical files

| Path | Change |
|---|---|
| `specs/42-faq-attribution-disclosure-fix.md` | **new** (this file) |
| `app/faq/page.tsx` | Three Q&A edits in the "Pricing & recovery" section (rewrite two existing, add one new) |

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

# Spec 53 — Paused state clarity: trial-ended banner + per-row "Trial ended" badge

## Context

Spec 51 introduced the post-first-recovery paused state and an ROI-framed
banner that drives Subscribe. Live testing on prod surfaced a real gap:
the banner currently conflates two messages — a celebration of the
recovery ("X is back at $Y/mo") and a subscription ask. For merchants
whose first recovery has `mrr_cents = 0` (e.g., Fitness App Live), the
celebration half reads as "X is back at $0/mo" — limp and confusing —
and pulls the urgency half down with it.

A second gap: the rest of the dashboard doesn't say "paused" anywhere
visible. The merchant looks at their subscriber table and sees rows
that *look* like the AI is working on them ("AI active" badge, "Pending"
badge, etc.) when in fact the AI has stopped sending. The state-change
is implicit — they have to read the banner to know the table is lying
to them.

The fix is to be explicit about cause and effect:

1. **Banner explains the causal story:** "Your trial ended on your first
   recovery. The AI has paused new sends until you subscribe."
2. **Numbers cover both cohorts:** the at-risk line includes cancellations
   AND failed payments, summed.
3. **Optional inner celebration strip:** only renders when
   `firstRecovery.mrrCents > 0`, so $0 recoveries don't get awkward
   text. The strip names the recovered subscriber + their MRR.
4. **Rows show "Trial ended":** every in-flight row (a row the AI would
   otherwise be working) gets a `⏸ Trial ended` amber badge instead of
   the normal "AI active" / "Awaiting retry" / etc. Already-recovered
   and already-lost rows keep their normal badges.

## Goals

- The merchant looking at the dashboard for the first time after their
  trial ended understands **what happened** (trial ended), **why** (first
  recovery delivered), **what's true now** (AI paused), **what it costs**
  (per-cohort at-risk sum), and **what to do** (Subscribe), in a single
  glance at the banner.
- The subscriber table no longer presents in-flight rows as if work is
  happening on them. Every paused-while-active row carries a `⏸ Trial
  ended` badge so the dormancy is visible at the row level.
- `$0 mrr_cents` recoveries don't render awkward "$0/mo restored" copy.

## Non-goals

- No change to the activation trigger or paused-state derivation —
  `activatedAt IS NOT NULL AND stripeSubscriptionId IS NULL` is still
  the only condition that turns this on, same as spec 51.
- No new database column or migration. The at-risk extension is a query
  change, not a schema change.
- No change to existing per-subscriber `aiPausedUntil` UX (spec 22a —
  founder manually pausing a specific subscriber). That's a different
  concept, kept distinct via the chosen badge label.
- No transient "recovery celebration" toast separate from the banner.
  The inner strip *inside* the paused banner is the only celebration
  acknowledgment; we don't want yet another piece of UI to maintain.
- No change to the payment-recovery `DunningStageBadge`'s normal-state
  styling — only adds the paused branch.

## Design

### Banner rewrite (single banner, conditional inner strip)

Trigger unchanged from spec 51:
`customer.activatedAt IS NOT NULL && !customer.stripeSubscriptionId && !onPilot`.

New copy (Case 1 — first recovery has revenue):

```
⏸  Your trial ended on your first recovery.
   The AI has paused new sends until you subscribe.

   ┌── First recovery ──────────────────────┐
   │ ✓ Sarah Lee · $50/mo restored          │
   └─────────────────────────────────────────┘

   $2,100/yr at risk across 7 more subscribers in your queue
   (4 cancellations + 3 failed payments).

   [Subscribe via Stripe →]   $99/mo + 1× MRR per recovery ·
                              Refundable for 14 days if they re-cancel
```

Case 2 (first recovery has `mrrCents === 0`): the inner strip is
**omitted entirely** and the at-risk line reads as `N subscribers`
without the "more" qualifier (since there's no headline recovery to
exclude from the count).

```
⏸  Your trial ended on your first recovery.
   The AI has paused new sends until you subscribe.

   $2,100/yr at risk across 7 subscribers in your queue
   (4 cancellations + 3 failed payments).

   [Subscribe via Stripe →]   $99/mo + 1× MRR per recovery ·
                              Refundable for 14 days if they re-cancel
```

Visual styling unchanged from spec 51: red-2 border, soft blue→emerald
gradient background, `⏸` icon. Only copy and the inner strip change.

### At-risk math extends to both cohorts

Today `app/dashboard/page.tsx` computes `atRiskCount` and
`atRiskMrrAnnualizedCents` from one query that filters to win-back
subscribers (cancellation_reason != 'Payment failed' OR NULL,
recovery_likelihood IN ('high', 'medium'), status != 'recovered').

We split this into two queries (or one query with cohort grouping) and
pass through:

```ts
interface AtRiskBreakdown {
  totalCount: number              // sum across cohorts
  totalMrrAnnualizedCents: number // sum across cohorts × 12
  cancellationsCount: number      // win-back cohort, non-recovered
  paymentRecoveriesCount: number  // dunning cohort, in-flight
}
```

Inclusion rules:

| Cohort | Predicate (in addition to `customerId = ?`) |
|---|---|
| Cancellations | `(cancellation_reason != 'Payment failed' OR cancellation_reason IS NULL) AND status != 'recovered' AND recovery_likelihood IN ('high', 'medium')` |
| Payment recoveries | `cancellation_reason = 'Payment failed' AND dunning_state IN ('awaiting_retry', 'final_retry_pending')` |

The "$N more" framing only applies to Case 1 (we subtract 1 from the
total because the recovered-named subscriber is broken out in the
celebration strip). For Case 2, we just print "N subscribers" without
the "more".

### Row badges — `⏸ Trial ended`

Naming choice: **"Trial ended"** rather than "Paused" to avoid
collision with the existing `paused` AI state (per-subscriber, founder
manually paused for N days — spec 22a). The two concepts are different
and the badge label needs to make that clear.

Two badges to update:

**Win-back rows — `components/ai-state-badge.tsx`:**

Add prop `billingPaused?: boolean`. When `billingPaused === true` AND
the derived ai state would otherwise be `active`, render:

```
<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5
             text-xs font-medium bg-amber-50 text-amber-700
             border border-amber-200">
  ⏸ Trial ended
</span>
```

When ai state is `handoff` / `paused` / `recovered` / `done`, render
the normal badge unchanged regardless of `billingPaused`. Rationale:

- `handoff` / `paused` — already not "actively working", rendering them
  as "Trial ended" is confusing because they have their own specific
  states the founder cares about
- `recovered` / `done` — terminal states, billing pause irrelevant

**Payment-recovery rows — `DunningStageBadge`:**

Same prop pattern. When `billingPaused === true` AND `dunningState IN
('awaiting_retry', 'final_retry_pending')`, render the `⏸ Trial ended`
badge instead of "Awaiting retry" / "Final retry". When dunningState is
`churned_during_dunning` / `recovered_during_dunning` / null, render
normally.

### Wiring `billingPaused` through

`app/dashboard/dashboard-client.tsx` already has the `isPaused`
boolean derived from server props (`!onPilot && isTrial &&
!!activatedAtIso`). Pass that down to each `<AiStateBadge>` and
`<DunningStageBadge>` instance via the new prop.

No new server-side state, no new fetch.

### Defensive gate in `sendReplyEmail`

Surfaced while drafting this spec — there's a real latent bug. Three of
the four subscriber-facing email senders already gate on
`isCustomerPausedForBilling`:

| Sender | Gated? |
|---|---|
| `scheduleExitEmail` | ✅ |
| `sendDunningEmail` | ✅ |
| `sendDunningFollowupEmail` | ✅ |
| **`sendReplyEmail`** | **❌** |

`sendReplyEmail` is the *actual win-back email* — fires after a
subscriber replies to their exit email. Called from two paths:

- `app/api/email/inbound/route.ts:323` — Resend inbound webhook (live
  reply arrives → AI classifies → send)
- `app/api/cron/reengagement/route.ts:300` — re-engagement cron (sends
  nudges to existing threads)

Without the gate, a subscriber who got their exit email *before* the
trial ended and replies *after* it ended would get a free win-back
email — making the new `⏸ Trial ended` badge a lie on those rows, and
silently violating "billing starts on first delivered recovery."

Fix: add the `isCustomerPausedForBilling` check to `sendReplyEmail`,
mirroring the pattern in the other three senders. Returns
`{ sent: false, reason: 'billing_paused' }` and emits
`send_skipped_billing_pause` with `emailType: 'reply'`.

### Reengagement cron — pre-filter paused customers

The defensive gate in `sendReplyEmail` is necessary but not sufficient
for the cron path. The cron does:

```
1. Select re-engageable subscribers across all customers
2. For each: classifySubscriber(...)  ← LLM call, ~$0.003
3. For each: sendReplyEmail(...)      ← gate fires here
```

For a paused merchant with N re-engageable subscribers, that's
**N × $0.003 of wasted Anthropic spend** every cron run, plus N noise
events in `wb_events`. The gate inside `sendReplyEmail` is too late —
the LLM call has already happened.

Fix: before the inner loop, check the customer's billing-paused state
once and skip the whole batch for paused customers:

```ts
// Group by customerId; for each customer in the candidate set, check
// isCustomerPausedForBilling once (using customerId directly, not
// subscriberId — needs a small overload or inline DB read). If paused,
// log a single send_skipped_billing_pause event with subscriberCount
// and skip all of that customer's candidate subscribers.
```

This generates one event per paused customer per cron run instead of
N, and avoids the LLM cost entirely.

A small helper: `isCustomerPausedForBillingByCustomerId(customerId)` —
same as the existing `isCustomerPausedForBilling` but skips the
churned_subscribers join. Keeps the cron's pre-filter cheap.

## Schema

No schema changes.

## Code paths touched

| File | Change |
|---|---|
| `app/dashboard/page.tsx` | Banner JSX rewrite; extend at-risk query to both cohorts; pass `atRiskBreakdown` to `DashboardClient` |
| `app/dashboard/dashboard-client.tsx` | New `AtRiskBreakdown` prop type; banner JSX updates (incl. conditional inner strip); pass `billingPaused={isPaused}` to row-badge components |
| `components/ai-state-badge.tsx` | New optional `billingPaused?: boolean` prop; new `⏸ Trial ended` badge variant; pre-empts `active` state when `billingPaused` is true |
| `src/winback/lib/email.ts` | Add `isCustomerPausedForBilling` gate to `sendReplyEmail` (mirrors the 3 existing gates); add `isCustomerPausedForBillingByCustomerId(customerId)` helper |
| `app/api/cron/reengagement/route.ts` | Pre-filter paused customers before the classify+send loop; emit one `send_skipped_billing_pause` event per paused customer (with `subscriberCount`) |
| `src/winback/__tests__/billing-pause-gate.test.ts` (extension) | Add coverage for `sendReplyEmail` paused-billing skip; reuse the existing fixture pattern |
| `src/winback/__tests__/ai-state-badge.test.ts` (new or extension) | Coverage for the `billingPaused` branch: shows trial-ended when active+paused, doesn't replace handoff/paused/recovered/done |
| Reengagement cron test (extension of existing) | Verify paused customers are skipped at the batch level before classifyCalled |
| Banner snapshot/unit test (light, in dashboard-client tests if any) | Verify inner strip renders only when `firstRecovery.mrrCents > 0` |

## Edge cases

- **`firstRecovery` is null** (shouldn't happen if `activatedAt` is set,
  but defensive): banner renders without the inner strip and the
  at-risk line says "across N subscribers" (not "N more").
- **`firstRecovery.mrrCents === 0`**: inner strip hidden, at-risk line
  says "across N subscribers" (not "N more").
- **`atRiskBreakdown.totalCount === 0`** (paused, but no in-flight
  subscribers — happens when the merchant has zero in-flight work):
  banner reads "$0/yr at risk across 0 subscribers in your queue."
  Still drives the subscribe ask via the trial-ended copy. Acceptable.
- **Pilot merchants** (`pilotUntil > now()`): paused banner doesn't
  render at all (existing spec 31 bypass). Unchanged.
- **Row badge collision with `aiPausedUntil`**: a subscriber the
  founder explicitly paused gets the existing `paused` (clock-icon)
  badge, not `Trial ended`. By design — the founder's explicit
  intent takes precedence in row-level state communication.
- **Cohort tab switching**: paused badges render on both tabs because
  both pass `billingPaused` independently. Same source of truth.
- **Cron pre-filter race**: if a merchant subscribes mid-cron-run, the
  pre-filter snapshots their state at iteration start, so they may get
  one cron run worth of "still paused" treatment. Next run picks up
  the new state. Acceptable — the cron is daily/hourly cadence.
- **`sendReplyEmail` called via the cron path**: defensive gate
  inside `sendReplyEmail` fires too, but no events are emitted from
  it because the cron pre-filter already short-circuited at the
  customer level. The defensive gate exists primarily for the inbound
  webhook path where there's no batch to pre-filter.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green; new tests added for:
      `billingPaused` AiStateBadge / DunningStageBadge branches,
      `sendReplyEmail` paused-billing skip, reengagement cron paused-customer pre-filter
- [ ] Manual click-through on dev (paused testfounder customer):
  - [ ] New banner copy renders
  - [ ] Case 1 (paused + recovery with mrr > 0): inner celebration strip
        shows; at-risk line says "N more subscribers"
  - [ ] Case 2 (paused + recovery with mrr === 0 — set via DB tweak):
        inner strip hidden; at-risk line says "N subscribers"
  - [ ] Win-back tab: rows with state `active` show `⏸ Trial ended`
        badge; handoff / paused (per-row) / recovered rows show
        their normal badges
  - [ ] Payment-recovery tab: rows in `awaiting_retry` or
        `final_retry_pending` show `⏸ Trial ended` badge; recovered /
        lost rows show normal badges
  - [ ] Subscribe → /billing/success → back to dashboard: banner is
        gone, all row badges revert to normal state (no `Trial
        ended` anywhere)
  - [ ] `atRiskBreakdown.cancellationsCount + paymentRecoveriesCount`
        matches the actual rows showing `Trial ended` on each tab
- [ ] Manual verification of the gate fixes:
  - [ ] Simulate a late reply via POST to `/api/email/inbound` for a
        paused customer's subscriber → response confirms skip; no
        `proactive_nudge_sent` event; `send_skipped_billing_pause` with
        `emailType: 'reply'` lands in `wb_events`
  - [ ] Trigger `/api/cron/reengagement?dryRun=1` for a paused customer
        with re-engageable candidates → log output shows the customer
        was pre-filtered; classifyCalled count is 0 for that customer's
        subscribers; one `send_skipped_billing_pause` event with
        `subscriberCount: N` rather than N separate events

## Out of scope

- Separate transient celebration toast (e.g., "🎉 Sarah was recovered
  1 day ago") — kept as the inner strip inside the same banner; not
  a separate UI piece
- Layout changes to KPI cards (the "paused-context KPI restyle" idea
  from the spec 51 mockup) — confusing layout-shift trade-off
- Top sticky paused bar — duplicative with the banner itself
- New copy variants A/B testing — pick once, ship, observe conversion
- Renaming the existing `paused` AI state (the founder-pause concept) —
  out of scope; we keep both states distinct via badge labels
- **Drain-on-subscribe** — when the merchant subscribes, sends that
  were skipped during the paused window (exit emails, dunning emails,
  reply win-backs) are **not retroactively retried**. The pause is
  gate-only, not queue-and-drain. Subscribers who cancelled during
  the pause-gap stay un-emailed. Performance fees DO drain on
  subscribe (`chargePendingPerformanceFees` in activation.ts) — that
  parallel mechanism exists for money, not sends. Whether to add a
  drain-on-subscribe for sends (and how to time-bound it so we don't
  send 3-week-late exit emails) is its own design decision, deferred
  to a follow-up spec. Re-engagement cron self-heals because it's a
  cadence: the next tick after subscription processes any
  re-engageable candidates normally.

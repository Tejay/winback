# Spec 51 — Billing trigger after first recovery: ROI framing + auto-pause + nudges

## Context

When the AI delivers the first recovery (win-back OR payment recovery) for
a merchant, today the dashboard banner asks them to "Add billing to keep
recovering" — generic, cost-framed, indefinitely-dismissable. The
[audit](51-audit-notes-for-myself.md) of the current flow surfaced four
distinct problems:

1. **"Not now" has no semantics.** It sets `localStorage.winback_banner_dismissed=true`
   and hides forever. No deferral window, no re-prompt, no server state.
   Different browser → banner returns. Cross-device inconsistent.
2. **No enforcement.** After dismissing, the AI keeps sending win-backs +
   payment recoveries. Performance fees pile up unbilled. A merchant could
   accumulate dozens of free recoveries indefinitely. The "billing starts
   on first recovery" promise is silently violated.
3. **No state visibility.** When the merchant ignores the banner, nothing
   on the dashboard tells them the billing trigger has happened. They
   don't know they're in a "freebie" state.
4. **Cost-framed ask, not value-framed.** "Add a payment method to start
   your $99/mo subscription" → the merchant reads cost first → defensive
   response → defer. The dashboard already has the data to invert this
   into an ROI frame ("$2,100/yr at risk in your dashboard right now").

The product principle: **the moment of first delivered value is the
highest-conversion moment Winback will ever have**. Don't dilute it with
deferral options. Don't bury the math in a vague CTA. And after that
moment, don't keep delivering free service indefinitely — that breaks
the trust contract, leaks revenue, and trains merchants to expect
free-forever.

## Design philosophy (single sentence)

**After the first recovery, the AI auto-pauses until the merchant
subscribes. The banner is ROI-framed. The paused state is visible
everywhere. Two scheduled emails nudge re-engagement. No manual pause
button — pause is implicit in "not subscribed".**

## Goals

- After **first delivered recovery of either type** — win-back
  (Connect `customer.subscription.created` after a churn) OR payment
  recovery (failed payment → updated card → `invoice.payment_succeeded`)
  — `activatedAt` is set and AI sending pauses for merchants without an
  active platform subscription. Whichever recovery type happens first
  triggers the billing event; subsequent recoveries of either type are
  also paused. New cancellations + failed payments still appear in the
  dashboard, but no win-back emails or payment-recovery emails are sent.
- Banner uses ROI framing: real customer name + MRR recovered, real
  count of currently-at-risk subscribers + annualized MRR-at-risk.
- Single primary CTA — Subscribe via Stripe → Stripe Checkout subscription
  mode (no intermediate steps, no in-app form, no second button).
- Paused state is visible in four layers: banner, persistent status
  strip, per-row "skipped — paused" badges, counterfactual stat cards.
- One transactional email at the trigger moment (rules announcement).
- Two scheduled re-engagement emails (day-7 + day-30 since
  `activatedAt`), idempotent via timestamp columns.
- **Ongoing monthly churn report email** after day-30, sent to paused
  merchants on a monthly cadence. One-line factual summary of what
  happened that month (cancellations, failed payments, estimated MRR at
  risk that Winback would have worked). Single CTA — Subscribe. Opt-out
  link in every email. Stops automatically if merchant subscribes or
  disconnects.
- Merchant can resume any time by subscribing. They can exit cleanly
  by disconnecting Stripe via `/settings` (existing path, unchanged).

## Non-goals

- **No "Pause Winback" button**. Pause is implicit — `activatedAt IS NOT
  NULL && stripeSubscriptionId IS NULL` is the paused state. No manual
  pause UI.
- **No "Remind me tomorrow" / "Not now" deferral options**. Banner has
  one CTA: Subscribe. Closing the banner has no semantics — it just
  hides for that page-render and returns on next reload.
- **No "free goodwill recovery" / "graduated commitment" / "perf-fee-only
  trial mode"**. Earlier drafts explored these; rejected for complexity.
  Single subscription tier, single trigger, single nudge cadence.
- **No daily/weekly drips**. Re-engagement cadence is: day-7 nudge,
  day-30 nudge, then monthly churn-report emails thereafter. Three
  touches in the first month, then one-per-month forever (or until
  subscribe / disconnect / opt-out). Monthly cadence ensures the
  merchant stays aware of value-at-risk without becoming annoying.
  Dashboard remains visible always (free-tier monitoring is intentional
  brand position).
- **No card-capture UI inside Winback.** Subscribe button → Stripe
  Checkout subscription mode → returns to `/dashboard`. Stripe handles
  card entry, 3DS, Apple Pay, address fields, receipts.
- **No N>1 trigger** (e.g., "ask after 3 recoveries"). N=1 is correct:
  best conversion psychology (recency), lowest free leak, simplest
  implementation.
- **No upfront commitment fee math** (e.g., "first invoice = $149"). The
  variable monthly bill makes upfront math misleading. Banner shows
  pricing structure ($99/mo + 1× MRR per recovery, refundable 14 days);
  Stripe Checkout shows the subscription detail; the actual invoice
  drains queued perf fees automatically.

## Schema / migration

`src/winback/migrations/032_billing_nudge_columns.sql`:

```sql
ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS billing_nudge_day7_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS billing_nudge_day30_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS billing_monthly_report_last_sent_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS billing_emails_opted_out_at TIMESTAMP;
```

Four timestamp columns:
- `billing_nudge_day7_sent_at`: idempotency for day-7 nudge (set once)
- `billing_nudge_day30_sent_at`: idempotency for day-30 nudge (set once)
- `billing_monthly_report_last_sent_at`: last-sent timestamp for the
  recurring monthly report (updated each send; new monthly send only
  fires if it's been ≥28 days since last)
- `billing_emails_opted_out_at`: merchant clicked "stop these reports"
  in a monthly email; suppresses all future billing-related nudges +
  monthly reports

No new columns for the paused state itself — derived from
`activatedAt` + `stripeSubscriptionId`.

## Code paths touched

### 1. Pause-gate the AI send pipelines

[src/winback/lib/email.ts](../src/winback/lib/email.ts) — extend
`scheduleExitEmail` (line 313). Early-return with reason when the
customer is in the paused state:

```ts
// Spec 51 — auto-pause after first recovery if no subscription
if (await isCustomerPausedForBilling(subscriberId)) {
  console.log('Skipping exit email — customer in post-trial pause:', subscriberId)
  await logEvent({
    name: 'send_skipped_billing_pause',
    properties: { subscriberId, reason: 'no_subscription_post_trial' },
  })
  return
}
```

New helper in same file:

```ts
export async function isCustomerPausedForBilling(subscriberId: string): Promise<boolean> {
  const [row] = await db
    .select({
      activatedAt: customers.activatedAt,
      stripeSubscriptionId: customers.stripeSubscriptionId,
    })
    .from(customers)
    .innerJoin(churnedSubscribers, eq(churnedSubscribers.customerId, customers.id))
    .where(eq(churnedSubscribers.id, subscriberId))
    .limit(1)
  return !!row?.activatedAt && !row?.stripeSubscriptionId
}
```

Same gate applied in payment-recovery email send paths
([src/winback/lib/email.ts](../src/winback/lib/email.ts) `sendDunningEmail`,
and the `sendDunningFollowupEmail` cron handler).

### 2. Trigger the "trial complete" transactional email

In `processRecovery` ([app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts) line 363+)
and `processCheckoutRecovery` (line 484), at the point a recovery row is
inserted: if this is the customer's *first* `wb_recoveries` row AND
`stripeSubscriptionId IS NULL`, send a one-time "trial complete" email
to the merchant.

Idempotency: only send if `activatedAt` was just set in this transaction
(i.e., the recovery insertion is the one that activated the customer).
The `triggerActivation` flow already sets `activatedAt` — we hook into
that path.

Email template: `sendPlatformTrialCompleteEmail` in
[src/winback/lib/billing-notifications.ts](../src/winback/lib/billing-notifications.ts).

```
Subject: 🎉 [SubscriberName] is back — trial complete

Your first recovery just delivered.

Going forward, Winback is paused until you subscribe:
  · No more win-back emails will be sent
  · No more payment recovery emails will be sent
  · You can still see all cancellations + failed payments in your dashboard

Subscribe to resume: {appUrl}/dashboard?subscribe=1
Or disconnect from /settings if Winback isn't right for you.

— The Winback team
```

### 3. Day-7 + day-30 cron nudges

New file: `app/api/cron/billing-nudge/route.ts`. Authenticated via
`CRON_SECRET` like the others.

```ts
// Pseudocode
export async function GET(req: NextRequest) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const day7Cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const day30Cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  // Day-7 nudges: paused customers, activated >=7 days ago, day7 nudge not yet sent
  const day7Targets = await db.select(...).from(customers).where(and(
    isNotNull(customers.activatedAt),
    isNull(customers.stripeSubscriptionId),
    isNull(customers.billingNudgeDay7SentAt),
    lt(customers.activatedAt, day7Cutoff),
  ))
  for (const c of day7Targets) {
    await sendBillingNudgeEmail(c, 'day7')
    await db.update(customers).set({ billingNudgeDay7SentAt: new Date() }).where(eq(customers.id, c.id))
    await logEvent({ name: 'billing_nudge_sent', customerId: c.id, properties: { day: 7 } })
  }

  // Day-30 nudges: same pattern, 30-day cutoff, day30 nudge not yet sent
  // ...

  return Response.json({ ok: true, day7Count: day7Targets.length, day30Count: day30Targets.length })
}
```

Register in [vercel.json](../vercel.json):

```json
{
  "path": "/api/cron/billing-nudge",
  "schedule": "0 10 * * *"
}
```

Daily at 10am UTC.

Email templates:

**Day 7:**
```
Subject: Quick check-in on your Winback account

Hey,

You paused Winback a week ago. Since then:
  · {N} cancellations
  · {M} failed payments
slipped past without recovery attempts.

Resume: {appUrl}/dashboard?subscribe=1

If Winback isn't right for you, disconnect Stripe via /settings.
```

**Day 30:**
```
Subject: Still paused — anything we can fix?

Hey,

You've been paused for a month. Resume any time: {appUrl}/dashboard?subscribe=1

Or if Winback isn't the right fit, disconnect via /settings — clean exit, no charges.

(If something specific kept you from using Winback, hit reply — would genuinely want to know.)
```

The `{N}` and `{M}` counts come from `wb_churned_subscribers` filtered
by customer + status + date.

### 3b. Monthly churn-report cron

Same `app/api/cron/billing-nudge/route.ts` file handles a third pass:
monthly report. Runs daily but only fires for a given customer if it's
been ≥28 days since `billing_monthly_report_last_sent_at` (or since
`billing_nudge_day30_sent_at` if monthly never sent).

Query:

```sql
SELECT id, ... FROM wb_customers
WHERE activatedAt IS NOT NULL
  AND stripeSubscriptionId IS NULL
  AND billing_nudge_day30_sent_at IS NOT NULL
  AND billing_emails_opted_out_at IS NULL
  AND (
    billing_monthly_report_last_sent_at IS NULL
      AND billing_nudge_day30_sent_at < NOW() - INTERVAL '28 days'
    OR
    billing_monthly_report_last_sent_at < NOW() - INTERVAL '28 days'
  )
```

For each: compute the last-30-day churn numbers from
`wb_churned_subscribers`, send the monthly report email, update
`billing_monthly_report_last_sent_at = NOW()`.

**Monthly report template:**

```
Subject: Your {Month} churn report

Hey,

Here's what happened on your Winback account in {Month}:

  · {N} cancellations
  · {M} failed payments
  · {K} subscribers classified as recoverable
  · ~${X}/yr in MRR that Winback would have worked

Resume: {appUrl}/dashboard?subscribe=1

Don't want these monthly reports? [Unsubscribe]({appUrl}/api/billing/opt-out?t={signedToken})

— The Winback team
```

The opt-out link is a signed token (same pattern as the existing
unsubscribe URL for subscribers) that hits a new endpoint
`/api/billing/opt-out` which sets `billing_emails_opted_out_at = NOW()`
on the customer. After opt-out: no more billing-related emails ever
(but dashboard banner still shows when they visit, and disconnecting
Stripe is still always available).

### 4. Dashboard banner — ROI framing

[app/dashboard/dashboard-client.tsx](../app/dashboard/dashboard-client.tsx)
`FirstRecoveryBanner` (line ~1451): replace copy + drop `dismissBanner`.
Banner renders when `activatedAt` set + `stripeSubscriptionId` null
(server-side check, NOT localStorage):

```jsx
🎉 {firstRecovery.name} is back at ${firstRecovery.mrrCents/100}/mo
   That's ${(firstRecovery.mrrCents * 12 / 100).toFixed(0)}/yr in recovered revenue.

You currently have {atRiskCount} more cancelled or failed-payment subscribers
in your dashboard worth ~${atRiskMrrAnnualized}/yr in MRR-at-risk.

Subscribe to start working them — $99/mo + 1× MRR per recovery
(refundable for 14 days if they re-cancel).

[ Subscribe via Stripe → ]
```

Data fetched in [app/dashboard/page.tsx](../app/dashboard/page.tsx):

```ts
// MRR at risk: subscribers classified as high/medium recoverability,
// status not 'recovered', no email_sent row (would have been sent if active)
const atRisk = await db
  .select({ mrrCents: churnedSubscribers.mrrCents })
  .from(churnedSubscribers)
  .where(and(
    eq(churnedSubscribers.customerId, customer.id),
    inArray(churnedSubscribers.recoveryLikelihood, ['high', 'medium']),
    ne(churnedSubscribers.status, 'recovered'),
  ))

const atRiskCount = atRisk.length
const atRiskMrrAnnualized = atRisk.reduce((sum, r) => sum + (r.mrrCents ?? 0) * 12, 0) / 100
```

### 5. Persistent paused-state UI

When `activatedAt && !stripeSubscriptionId`:

- **Skinny status bar** at top of every dashboard page (above the main
  banner): `⏸ Winback is paused — recoveries won't send. [Subscribe to resume]`
- **Per-row badge** on subscriber list: cancellations that arrived after
  `activatedAt` show `⏸ Skipped — paused` instead of `Lost`. Hover
  tooltip: *"Winback didn't send because no active subscription.
  Subscribe to start working subscribers again."*
- **Stat card counterfactual**: `8 cancellations this month` becomes
  `8 cancellations this month — 3 likely recoverable, ~$240/mo at risk`.

### 6. Subscribe button → Stripe Checkout

Existing flow (per spec 23): `POST /api/billing/checkout` opens Stripe
Checkout in `mode: 'subscription'`. Verify the existing endpoint works
end-to-end. Banner CTA simply navigates to the checkout URL returned by
that endpoint. Returns to `/dashboard?subscribe=success` on success.

## Edge cases

| Case | Behavior |
|---|---|
| Multiple recoveries before subscribe | Only first triggers `activatedAt`. Banner shows on all subsequent dashboard renders until subscribed. AI stays paused regardless of recovery count. |
| Merchant subscribes mid-cycle | `stripeSubscriptionId` becomes set. Banner disappears next render. AI resumes immediately on next webhook. Queued perf fees drain onto first invoice (existing behavior). |
| Merchant never has a recovery | `activatedAt` never set. Banner never shows. AI runs forever. **Acceptable** — honors "billing starts on first delivered recovery" promise (no recovery → no billing). |
| Merchant disconnects Stripe | `stripeAccessToken` becomes null. Existing disconnect flow handles it. Webhook gates already short-circuit. AI cannot send (no Stripe access). |
| Merchant subscribes, then cancels subscription | `stripeSubscriptionId` cleared via `processPlatformSubscriptionDeleted` (spec 23). Falls back into paused state. Banner returns. |
| Day-7 nudge cron fires while merchant is in process of subscribing | Cron checks `stripeSubscriptionId IS NULL` at query time. If they subscribed minutes earlier, no nudge sent. |
| Cron retries (Vercel timeout, etc.) | `billing_nudge_day7_sent_at` idempotency column ensures no duplicate emails. |
| Merchant subscribed → banner dismissed → unsubscribed → re-pauses | Banner returns. Day-7/30 nudges *don't* re-fire (timestamp columns are set-once). Monthly reports DO continue (cadence-based, not single-fire). Acceptable; rare repeat-pause case. |
| Merchant clicks "Unsubscribe" in a monthly report email | `billing_emails_opted_out_at` set. All future billing-related emails (nudges + monthly reports) suppressed. Dashboard banner unaffected — they can still subscribe in-app any time. |
| Win-back recovery triggers `activatedAt` first, then a payment recovery delivers next | Only the FIRST recovery triggers `activatedAt` + the trial-complete email. Subsequent recoveries (of either type) are silently paused; they appear in dashboard with `Skipped — paused` status. |
| Customer disconnects Stripe while paused | `stripeAccessToken` cleared. Cron's WHERE clause should also exclude disconnected customers (`stripeAccessToken IS NOT NULL`) — add that filter to all three nudge queries. |
| AI suppression returns `suppress: true` for a cancellation during pause | Already early-returns from classifier suppression (existing behavior). The pause early-return runs first and short-circuits anyway. |
| `activatedAt` set but recovery row doesn't exist (data corruption) | Banner has no `firstRecovery` data — falls back to a generic ROI ask without the specific name. UI handles `firstRecovery: null` gracefully. |

## Verification

### Pre-merge (on branch)

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` green; existing tests for `scheduleExitEmail` updated to cover the new pause early-return
- [ ] New unit tests:
  - `src/winback/__tests__/billing-pause-gate.test.ts` — covers
    `isCustomerPausedForBilling`: returns true when activatedAt set + no sub,
    false when activatedAt null, false when sub set
  - `src/winback/__tests__/billing-nudge-cron.test.ts` — covers cron
    selecting day-7 + day-30 targets, idempotency, auth gate
- [ ] Diff is exactly the files listed in §3 below + `vercel.json` cron addition

### Post-merge smoke (on dev DB)

- [ ] Manually set `activatedAt = NOW()` and `stripeSubscriptionId = NULL` on a test customer
- [ ] Trigger a fake `customer.subscription.deleted` webhook against that customer's connected account
- [ ] Confirm `wb_emails_sent` table gets NO new exit email row
- [ ] Confirm `wb_events` shows a `send_skipped_billing_pause` row
- [ ] Open `/dashboard` as that customer — confirm banner shows ROI framing with real numbers, status bar shows "paused", per-row badge appears on the new churn row
- [ ] Click Subscribe button — confirm redirects to Stripe Checkout subscription mode
- [ ] Manually set `billing_nudge_day7_sent_at = NULL` and `activatedAt = NOW() - INTERVAL '8 days'`. Hit `/api/cron/billing-nudge` with the right `CRON_SECRET`. Confirm day-7 email lands in inbox and timestamp column updates.
- [ ] Same drill for day-30 with 31-day cutoff.

### Production rollout safety

- [ ] Migration 032 applied to dev branch first, verified, then prod branch
- [ ] Vercel.json cron registration deploys cleanly (Vercel re-evaluates cron config on push)
- [ ] First few production cron firings monitored via `/admin/events` → look for `billing_nudge_sent` events without errors

## Branch + PR

- Branch: `feat/spec-51-billing-trigger-roi-framing`
- PR title: `Spec 51: ROI-framed billing trigger + auto-pause + nudge crons`

## Files touched (summary)

**New:**
- `src/winback/migrations/032_billing_nudge_columns.sql`
- `app/api/cron/billing-nudge/route.ts` (handles day-7 + day-30 + monthly)
- `app/api/billing/opt-out/route.ts` (signed-token endpoint for "stop monthly reports")
- `src/winback/__tests__/billing-pause-gate.test.ts`
- `src/winback/__tests__/billing-nudge-cron.test.ts`
- `src/winback/__tests__/billing-opt-out.test.ts`

**Modified:**
- `lib/schema.ts` (add 4 timestamp columns to `customers`)
- `src/winback/lib/email.ts` (add `isCustomerPausedForBilling`, gate
  `scheduleExitEmail` + `sendDunningEmail` + dunning followup)
- `src/winback/lib/billing-notifications.ts` (add
  `sendPlatformTrialCompleteEmail`, day-7 + day-30 nudge sender helpers,
  monthly-report sender)
- `app/api/stripe/webhook/route.ts` (trigger trial-complete email when
  `activatedAt` is first set inside `triggerActivation`)
- `app/dashboard/page.tsx` (compute MRR-at-risk numbers + atRiskCount)
- `app/dashboard/dashboard-client.tsx` (replace `FirstRecoveryBanner`
  copy with ROI framing, drop `dismissBanner` localStorage path, add
  persistent status bar, add per-row paused badge, counterfactual stat
  cards)
- `vercel.json` (register billing-nudge cron at 10am UTC daily)

**Total estimate:** ~350 lines added / ~50 lines removed (the existing
banner implementation), 3 new test files (~80 lines each), 1 migration.
~1.5 days of focused work.

## Out of scope (post-launch follow-ups)

- **Per-customer ROI breakdown emails** (e.g., "this week's would-have-been recoveries: ...")
- **One-click resume from email** (currently the email links to the dashboard subscribe banner; could go directly to Stripe Checkout)
- **Soft-archive after 90 days paused** (currently the merchant just sits there forever; eventually want a tidy-up flow)
- **A/B testing the banner copy** (would need a flag system; defer until baseline conversion data exists)

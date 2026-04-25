# Spec 26 — Operational Admin Dashboard (Phase 2)

**Phase:** Weeks 2–4 of live customers
**Depends on:** Spec 25 (Phase 1 admin shell + auth + read-only role), migration 018

---

## Summary

Phase 2 of the internal `/admin` area. Three workstreams that Phase 1 surfaced as needed:

1. **Two new pages**: `/admin/ai-quality` (catch AI judgment drift before it spams founders) and `/admin/billing` (make sure 15%-of-recovery revenue actually collects).
2. **Close the error-event taxonomy** — wire `logEvent` into four uninstrumented failure paths so the overview's Errors counter reflects real platform health.
3. **Phase 1 refinements** identified during dogfooding: $ recovered counter, replies→handoffs swap, split errors counter, "events outside range" hint, bulk DNC.

No new schema. No new auth pattern. Reuses Phase 1's `requireAdmin()` + `getDbReadOnly()` + `lib/admin/*` substrate.

---

## Context

Phase 1 shipped four pages and the safety-net infra (read-only DB role, audit logging, cross-customer search). Three observations from running it:

- **Operational blind spots** — Resend send failures, Anthropic classifier failures, webhook signature failures, and DB errors all throw exceptions but emit no events. The overview's "Errors today" counter undercounts real incidents because we never logged them. A flaky transactional-email provider, a parse-failure regression after a model update, or a webhook-secret rotation gap would all go invisible.
- **Revenue clarity is missing** — recoveries are counted by row, but the dashboard shows them as integers. The single most important business metric ($ recovered today) is buried — you have to mentally multiply by MRR to feel the impact of the day.
- **AI-quality drift isn't observable** — we ship classifier prompt changes (specs 25's tone work, hand-off judgment, etc.) and have no instrumented way to see whether handoff volume is climbing or recovery-likelihood distribution is shifting. Without it, a regression in classifier judgment ships and we find out from a customer.

Phase 2 closes these.

---

## Schema

**No migration.** All queries hit existing tables and indexes:
- `wb_events` (`name, created_at`) and (`customer_id, created_at`) indexes — overview rollups, event log, ai-quality timeseries
- `wb_churned_subscribers` — current-state slices for handoff audit, recovery-likelihood distribution, tier distribution
- `wb_billing_runs` (`customer_id, period_yyyymm` UNIQUE) — billing run status
- `wb_recoveries` — outstanding obligations + MRR trend

If any new query hits seq scans at scale, add indexes in a follow-up; not preemptive.

---

## 26.1 `/admin/ai-quality`

**Route:** `app/admin/ai-quality/page.tsx`
**API:** `app/api/admin/ai-quality/route.ts`

Single-page dashboard, four blocks. All queries use `dbReadOnly`.

### Block A — Handoff volume trend (30d)

Daily count of `founder_handoff_triggered` events for the last 30 days, rendered as a 30-bucket bar/sparkline.

```sql
SELECT date_trunc('day', created_at) AS day, count(*)::int AS n
FROM wb_events
WHERE name = 'founder_handoff_triggered'
  AND created_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1;
```

**What it answers:** Is the AI's escalation rate climbing? Is it close to zero (which means it's never escalating, which is suspicious)? A sustained spike = prompt regression sending too many cases to founders. A flatline = either a tone fix worked, or it's broken and we're silent-closing things we should escalate.

Renders alongside the count of `subscriber_auto_lost` for the same period — if handoffs went down AND auto-lost went up, the AI is failing closed in a bad way.

### Block B — Recovery likelihood distribution

Histogram of `wb_churned_subscribers.recovery_likelihood` for subscribers classified in the last 30 days. Three bars: high / medium / low.

```sql
SELECT recovery_likelihood, count(*)::int AS n
FROM wb_churned_subscribers
WHERE recovery_likelihood IS NOT NULL
  AND created_at > now() - interval '30 days'
GROUP BY 1;
```

**What it answers:** Is the model calibrated? Healthy distribution is roughly 10–20% high / 30–40% medium / 40–60% low. A sudden majority of `high` = the model became overly optimistic. A majority of `low` = it gave up on everyone.

### Block C — Tier distribution over time

Stacked daily counts of subscribers by tier (1–4) classified in the last 30 days.

```sql
SELECT date_trunc('day', created_at) AS day,
       tier,
       count(*)::int AS n
FROM wb_churned_subscribers
WHERE created_at > now() - interval '30 days'
  AND tier IS NOT NULL
GROUP BY 1, 2;
```

**What it answers:** A sudden Tier-4 surge = the classifier started suppressing things it shouldn't (silent-failure mode after a prompt change). Tier-1 climbing = more subscribers giving us actionable reasons (good).

### Block D — Hand-off reasoning audit (last 50)

Most recent 50 `founder_handoff_triggered` events, joined with the subscriber row to surface the AI's full `handoff_reasoning` and `recovery_likelihood`. Each row links to the subscriber drawer (reuses cross-customer search drawer from Phase 1).

```sql
SELECT s.id,
       s.name,
       s.email,
       s.handoff_reasoning,
       s.recovery_likelihood,
       s.mrr_cents,
       s.cancellation_reason,
       s.founder_handoff_at,
       c.product_name,
       u.email AS customer_email
FROM wb_churned_subscribers s
JOIN wb_customers c ON c.id = s.customer_id
JOIN wb_users    u ON u.id = c.user_id
WHERE s.founder_handoff_at IS NOT NULL
ORDER BY s.founder_handoff_at DESC
LIMIT 50;
```

**What it answers:** Is the AI's reasoning quality consistent? Spot-read 10 a week — if you find 3 you'd disagree with, the prompt needs work.

### Block E — Silent-close audit (last 50)

Most recent 50 `subscriber_auto_lost` events with the reasoning the AI gave at the moment of close.

```sql
SELECT e.created_at, e.properties, e.customer_id, c.product_name, u.email
FROM wb_events e
LEFT JOIN wb_customers c ON c.id = e.customer_id
LEFT JOIN wb_users     u ON u.id = c.user_id
WHERE e.name = 'subscriber_auto_lost'
ORDER BY e.created_at DESC
LIMIT 50;
```

**What it answers:** Cases the AI silently closed instead of escalating. If you read these and think "I'd have wanted this one" → the prompt is too aggressive about closing out and needs adjusting.

---

## 26.2 `/admin/billing`

**Route:** `app/admin/billing/page.tsx`
**API:** `app/api/admin/billing/route.ts`, `app/api/admin/actions/billing-retry/route.ts` (mutation)

Three blocks.

### Block A — Latest monthly run status breakdown

Status counts for the current period `YYYY-MM` from `wb_billing_runs`.

```sql
SELECT status, count(*)::int AS n
FROM wb_billing_runs
WHERE period_yyyymm = to_char(now(), 'YYYY-MM')
GROUP BY status;
```

Renders as a horizontal bar with five segments: `paid` (green), `pending` (amber), `failed` (red), `skipped_no_obligations` (slate), `skipped_no_card` (slate). Includes a "View all runs (90d)" link to the failed-invoices block below.

### Block B — Failed invoices (last 90d)

Table of `status = 'failed'` runs from the last 90 days with a Retry button per row.

```sql
SELECT br.id, br.customer_id, br.period_yyyymm, br.amount_cents,
       br.stripe_invoice_id, br.created_at, c.product_name, u.email
FROM wb_billing_runs br
JOIN wb_customers c ON c.id = br.customer_id
JOIN wb_users     u ON u.id = c.user_id
WHERE br.status = 'failed'
  AND br.created_at > now() - interval '90 days'
ORDER BY br.created_at DESC;
```

**Retry button** → `POST /api/admin/actions/billing-retry { runId }`:
- Loads the run by id (mutation uses privileged `db` connection)
- If `status != 'failed'` → 409 ("not in failed state")
- Updates row to `status='pending', stripe_invoice_id=null` (idempotent — UNIQUE(customer_id, period_yyyymm) protects against double-creation)
- Calls into the existing monthly billing function (`src/winback/lib/billing.ts:processBillingRun(customerId, period)` — already exists per spec 24a) which creates the Stripe invoice and updates the row
- Logs `admin_action { action: 'billing_retry', runId, customerId }`

If the existing billing module isn't refactorable into a per-customer-per-period entry point, this PR refactors it as part of the build. (One of the costs of Phase 2 — the cron is currently monolithic.)

### Block C — Outstanding obligations

Strong recoveries that don't have a `paid` billing run covering their recovery period. The "money we should have collected but haven't" report.

```sql
SELECT r.id, r.customer_id, r.recovered_at, r.plan_mrr_cents,
       to_char(r.recovered_at, 'YYYY-MM') AS period,
       c.product_name, u.email
FROM wb_recoveries r
JOIN wb_customers c ON c.id = r.customer_id
JOIN wb_users     u ON u.id = c.user_id
WHERE r.attribution_type = 'strong'
  AND r.still_active = true
  AND NOT EXISTS (
    SELECT 1 FROM wb_billing_runs br
    WHERE br.customer_id = r.customer_id
      AND br.status = 'paid'
      AND br.period_yyyymm = to_char(r.recovered_at, 'YYYY-MM')
  )
ORDER BY r.recovered_at DESC;
```

Each row shows: customer, recovery date, MRR, target period, expected fee (15% of MRR). Total at the top: "$X total outstanding across N recoveries".

### Block D — MRR-recovered trend

Weekly rollup of `wb_recoveries.plan_mrr_cents` split by attribution type, last 90 days.

```sql
SELECT date_trunc('week', recovered_at) AS week,
       attribution_type,
       sum(plan_mrr_cents)::bigint AS cents,
       count(*)::int AS n
FROM wb_recoveries
WHERE recovered_at > now() - interval '90 days'
GROUP BY 1, 2
ORDER BY 1;
```

Renders as a stacked bar by week: `strong` (billable) / `weak` / `organic`. Hover reveals dollar totals.

---

## 26.3 Observability gap fixes

Four places that throw exceptions today but emit no `wb_events` row. Each is ~6 lines in the catch block. Once wired, the overview's Errors counter reflects real platform health.

| Path | Where | Event name | Properties |
|---|---|---|---|
| Resend send fail | `src/winback/lib/email.ts` `sendEmail`, `sendReplyEmail`, `sendDunningEmail` | `email_send_failed` | `{ subscriberId, type, errorMessage }` |
| Anthropic classifier fail | `src/winback/lib/classifier.ts` `classifySubscriber` (Zod parse + API throw) | `classifier_failed` | `{ stripeCustomerId, errorType: 'parse'\|'api', errorMessage }` |
| Stripe webhook signature fail | `app/api/stripe/webhook/route.ts` (existing 400 path) | `webhook_signature_invalid` | `{ sourceIp, errorMessage }` |
| DB error in handlers | top-level `try/catch` in webhook + cron handlers | `db_error` | `{ surface, errorMessage }` |

Pattern (consistent across all four): emit BEFORE re-throwing so the row lands even when the request 500s.

```ts
try {
  // existing code
} catch (err) {
  await logEvent({
    name: 'email_send_failed',
    customerId,
    properties: {
      subscriberId,
      type: 'exit',
      errorMessage: err instanceof Error ? err.message : String(err),
    },
  })
  throw err
}
```

Then extend `EVENT_NAMES` in `app/admin/events/events-client.tsx` (the filter dropdown) with the four new names. And update the overview's error sum in `lib/admin/rollups.ts` to include them.

---

## 26.4 Overview refinements

### MRR-recovered counter (sixth tile)

Adds a top-level `$X recovered today` counter with 7-day sparkline. The single most important business metric, currently buried in the recoveries split.

```sql
-- Today
SELECT coalesce(sum(plan_mrr_cents), 0)::bigint AS cents
FROM wb_recoveries
WHERE recovered_at >= date_trunc('day', now())
  AND attribution_type = 'strong';   -- billable only

-- 7-day sparkline (daily totals)
SELECT date_trunc('day', recovered_at) AS day,
       sum(plan_mrr_cents)::bigint AS cents
FROM wb_recoveries
WHERE recovered_at > now() - interval '7 days'
  AND attribution_type = 'strong'
GROUP BY 1
ORDER BY 1;
```

Render as `$XXX.YY recovered` with the existing `▁▂▃▄▅▆▇` sparkline. Strong-only because that's what's actually billable.

### Replies → handoffs counter swap

Replace the Replies counter with `Hand-offs triggered today`. Reply count is a weak signal once volume is up — it doesn't distinguish happy from angry replies and undercounts cases where the AI handled a reply silently. Hand-offs map directly to the AI-quality question.

```sql
SELECT count(*)::int FROM wb_events
WHERE name = 'founder_handoff_triggered'
  AND created_at >= date_trunc('day', now());
```

Sparkline same shape as before.

### Split errors counter

Replace the single Errors counter with three side-by-side micro-counters: OAuth / Billing / Reactivate. Once 26.3 lands, expand to include Send + Classifier + WebhookSig + DB. Each gets its own sparkline. Click-through on any of them filters `/admin/events` by that name.

Layout: same row as the existing 5 counters, but the Errors tile becomes a flex container with three (eventually seven) micro-tiles.

---

## 26.5 Events page refinements

### "Customer has events outside this date range" hint

When `?customer=` resolves to a customer but the date filter returns zero events, the API computes a separate count of events for that customer outside the date range, returns it as `customerEventsOutsideRange: <count>`, and the UI renders an amber hint:

> *This customer has 39 events outside the chosen date range. [Extend to 30 days]*

The "Extend to 30 days" button updates the date-range select and re-runs the query. Avoids the silent-zero failure mode.

API change:

```ts
// app/api/admin/events/route.ts (extension)
if (customerId && rows.length === 0) {
  const [outside] = await getDbReadOnly()
    .select({ n: sql<number>`count(*)::int` })
    .from(wbEvents)
    .where(eq(wbEvents.customerId, customerId))
  if (outside?.n > 0) {
    return NextResponse.json({
      rows: [],
      total: 0,
      customerEventsOutsideRange: outside.n,
    })
  }
}
```

---

## 26.6 Subscribers page refinements (bulk DNC)

When a complaint cites multiple customers ("I keep getting emails from your platform — three different products"), today the support flow is N clicks. Add multi-select.

UI changes (`app/admin/subscribers/subscribers-search-client.tsx`):
- Each search-result row gets a checkbox in a leading column
- A bulk-action bar appears when ≥1 row is selected: `"3 selected — [Mark all DNC] [Clear]"`
- "Mark all DNC" calls a new API endpoint with the array of subscriber ids

New API: `POST /api/admin/actions/bulk-unsubscribe`
```ts
{ subscriberIds: string[] }   // max 100 per request
```
Atomically marks all as DNC. Logs one `admin_action { action: 'bulk_unsubscribe', count, subscriberIds: [...] }` event so the audit trail captures the batch (not 100 individual events). Returns `{ ok: true, count: N }`.

---

## File manifest

**New files:**
- `app/admin/ai-quality/page.tsx` + `ai-quality-client.tsx`
- `app/admin/billing/page.tsx` + `billing-client.tsx`
- `app/api/admin/ai-quality/route.ts`
- `app/api/admin/billing/route.ts`
- `app/api/admin/actions/billing-retry/route.ts`
- `app/api/admin/actions/bulk-unsubscribe/route.ts`
- `lib/admin/billing-queries.ts` — outstanding obligations + retry helpers (extracted so they're testable)
- `lib/admin/ai-quality-queries.ts` — handoff trend + likelihood distribution + audit samples
- `src/winback/__tests__/admin-ai-quality.test.ts` — query helpers
- `src/winback/__tests__/admin-billing.test.ts` — outstanding-obligations + retry idempotency

**Modified files:**
- `lib/admin/rollups.ts` — extend `OverviewRollup` with `mrrCentsToday`, `mrrSparkline`, `handoffsToday`, `handoffsSparkline`; split errors into per-source counters
- `app/admin/overview-client.tsx` — render the new tile + replace Replies with Handoffs + render the split errors
- `app/admin/events/events-client.tsx` — extend `EVENT_NAMES` with new error events; render `customerEventsOutsideRange` hint
- `app/admin/subscribers/subscribers-search-client.tsx` — checkboxes + bulk-action bar
- `app/admin/layout.tsx` — add nav links for `/admin/ai-quality` and `/admin/billing`
- `app/api/admin/events/route.ts` — emit `customerEventsOutsideRange` when applicable
- `src/winback/lib/email.ts` — wrap Resend calls; emit `email_send_failed`
- `src/winback/lib/classifier.ts` — wrap Anthropic + Zod paths; emit `classifier_failed`
- `app/api/stripe/webhook/route.ts` — emit `webhook_signature_invalid` on 400 path
- Top-level cron + webhook handlers — wrap in try/catch with `db_error`
- `src/winback/lib/billing.ts` — refactor monthly billing entry point so a single `(customerId, period)` retry is callable from the admin UI

---

## Test requirements

Following the Phase 1 pattern (mock DB + Resend, verify behaviour):

- **`lib/admin/ai-quality-queries.ts`** — handoff trend returns daily buckets shape; likelihood histogram normalises null to 'low'; tier distribution covers all 4 tiers
- **`lib/admin/billing-queries.ts`** — outstanding obligations excludes recoveries already covered by a paid run; retry rejects non-failed rows with 409
- **`bulk-unsubscribe` route** — atomically updates all ids; logs ONE `admin_action` with the batch (not N events)
- **Observability gap unit tests** — for each of the four error paths, verify the catch block emits `logEvent` BEFORE re-throwing (key invariant: row lands even on 500)
- **Events route `customerEventsOutsideRange`** — when customer resolves and rows=0 but events exist outside the window, returns the count

---

## Verification

1. `npx tsc --noEmit` — clean
2. `npx vitest run` — all new + existing tests green
3. End-to-end on `npm run dev` after seeding via `/test/winback-flow`:
   - **AI quality dogfood**: classify 5 subscribers via the harness, hand off 1, auto-lose 1. Visit `/admin/ai-quality`. Verify all four blocks render with non-zero data.
   - **Billing retry**: manually `UPDATE wb_billing_runs SET status='failed' WHERE id=...` for a test row. Visit `/admin/billing`, click Retry, verify status transitions failed → pending → paid (or failed again with the new error captured).
   - **Outstanding obligations**: simulate a strong recovery via the harness, verify it appears in the outstanding list before the next billing cron runs.
   - **MRR counter**: simulate-recovery with attribution=strong on the harness. Verify the `$X recovered today` tile increments and the sparkline rises.
   - **Bulk DNC**: search for an email with 3 hits across customers, select all, click Mark all DNC, verify all three rows show the DNC badge and one `admin_action` event lands (not three).
   - **Error instrumentation**: deliberately misconfigure `RESEND_API_KEY` to a known-bad value. Trigger an exit email send via the harness. Verify `email_send_failed` event lands AND the original 500 still bubbles.
   - **Webhook signature failure**: send a Stripe webhook with a wrong signature using `stripe trigger` against a misconfigured secret. Verify `webhook_signature_invalid` event lands.
   - **Events page hint**: search for a customer email known to have only old events (>30d), verify the "outside range" hint renders and the "Extend to 30 days" button works.

---

## Out of scope (deferred to Phase 3)

Same list as in spec 25:
- Admin audit-log UI (filtered view of `admin_action` events)
- Customer impersonation
- Webhook replay
- Real-time WebSocket / Server-Sent Events
- Email template editor
- Manage-admins UI

Plus, deferred from this Phase 2 cycle if scope creeps:
- **Per-customer cohort analysis** on AI quality (handoff rate per founder, recovery likelihood by product) — currently global only. Defer until we have ≥10 customers and the per-founder slice is meaningful.
- **Drill-down on the MRR sparkline** — clicking a day on the trend opens a list of the recoveries that contributed. Nice-to-have.

---

## Design decisions

### Why split AI quality and billing into separate pages (vs one mega-dashboard)

Different audiences and cadences. AI quality is a weekly read for whoever owns the prompt; billing is a monthly read tied to the cron + a real-time read when something fails. Mixing them on one page makes both worse. Separate URLs also let us link to them from automation later (cron emails a "billing run summary" link → straight to `/admin/billing`).

### Why retry only failed runs (not re-create paid ones)

`wb_billing_runs` UNIQUE(customer_id, period_yyyymm) prevents double-billing. Allowing re-creation of paid runs would let a misclick double-charge a customer. Retrying only `failed` runs is idempotent + safe.

### Why instrument errors in catch BEFORE re-throwing

If we emit the event AFTER the throw, the row never lands when the surrounding handler converts the error to a 500. Emitting first means the trail is visible even when the request itself failed. The trade-off: one extra DB write per failure. Acceptable — failures are by definition rare, and visibility on them is the point.

### Why not pre-compute aggregations into a materialized view

The queries are cheap at our current scale (all hit indexed paths, all bounded by `LIMIT 50`/`100` or short time windows). Materialised views add operational complexity (refresh schedules, staleness windows) for sub-millisecond gains we don't need yet. Revisit if the AI quality page exceeds 1s on real data.

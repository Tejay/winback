# Spec 54 — Drain on subscribe: AI-decided processing of paused-window events

## Context

Specs 51–53 introduced and clarified the post-trial paused state.
Spec 53 explicitly left **drain-on-subscribe** out of scope: events
that piled up during the paused window (new cancellations, failed
payments, subscriber replies) were not retroactively processed when
the merchant subscribes. Re-engagement self-heals via its daily
cron, but the three other event types stay un-emailed forever — a
real product gap that becomes painful at launch.

A merchant who subscribes after their 5-day paused window expects
the AI to "catch up" on the backlog they paid to recover. Not
leaving a third of their dashboard permanently dormant.

The natural design question is "how late is too late to send?". The
obvious answer is a fixed time cutoff. But Winback's whole brand is
*AI-decided* — and the classifier already exposes `tier=4` /
`suppress` / `handoff` outcomes that handle "don't send" cleanly.
Layering a parallel time-based skip path on top of that would
conflict with the AI-judgment paradigm. So: the AI decides per
subscriber, with `daysElapsedSinceEvent` added as an input signal.
A coarse DB-level filter at 180 days bounds the worst case (ancient
backfilled rows from an old import).

## Design philosophy (single sentence)

**A scheduled cron that finds individual subscribers needing
drain-processing and processes them one at a time; per-row state
makes both progress and failure recovery trivial — anything not
yet processed sits in the filter and gets retried on the next tick.**

## Goals

1. After a merchant subscribes, events that piled up during their
   paused window get processed automatically. No ghost rows stay
   un-emailed.
2. Decision to send/skip/handoff each item is AI-driven — same
   mechanism as the normal flow, extended with `daysElapsedSinceEvent`
   context.
3. Founder can inspect *why* each item was sent or skipped via the
   existing `handoffReasoning` field; can manually override via
   spec 50's compose helper.
4. Failure recovery is automatic — a per-row marker means
   half-processed customers resume on the next cron tick. No claim
   columns, no TTLs, no detached promises.
5. Idempotent at the row level — re-processing a row never
   double-sends an email.

## Non-goals

- **No fire-and-forget from `/billing/success` or the webhook.** The
  earlier design did that with `waitUntil`; it works but introduces
  detached-promise + crash-recovery complexity that a cron sidesteps.
- **No drain progress UI** beyond a single line of copy on
  `/billing/success` and the natural live-update behaviour of
  dashboard rows.
- **No time-based send/skip cutoff as a product feature.** The
  180-day DB filter is a sanity bound on the query, not a "stale"
  badge in the UI.
- **No re-classification for category B (payment recovery).** Dunning
  emails use a static template; AI judgment applies only to
  cancellations + replies.
- **No drain across pre-paused-state subscribers.** This is for events
  that arrived *during* a customer's paused window — not a backfill
  of all un-emailed history ever.
- **No drain for pilot graduations.** Pilot mode (spec 31) bypasses
  the billing-pause gate entirely, so pilot merchants don't
  accumulate a queue.
- **No global retry queue / Vercel Queues.** Cron + per-row state is
  enough durability for the launch context. We can upgrade later if
  drain reliability becomes a problem.

## Design

### What's in the queue (three categories)

For every subscribed customer, the cron looks at three filters
across `wb_churned_subscribers`. Each filter intentionally only
matches rows the cron has not yet successfully processed —
`pause_drain_processed_at IS NULL` is the queue-membership signal.

**A. Late cancellations (queued exit emails)**

```sql
SELECT s.* FROM wb_churned_subscribers s
JOIN wb_customers c ON s.customer_id = c.id
WHERE c.activated_at IS NOT NULL
  AND c.stripe_subscription_id IS NOT NULL
  AND s.pause_drain_processed_at IS NULL          -- not yet processed
  AND s.status = 'pending'                         -- exit email never landed
  AND s.email IS NOT NULL
  AND s.do_not_contact = false
  AND (s.ai_paused_until IS NULL OR s.ai_paused_until < NOW())
  AND s.founder_handoff_at IS NULL
  AND s.cancelled_at > NOW() - INTERVAL '180 days' -- sanity bound
  AND NOT EXISTS (
    SELECT 1 FROM wb_emails_sent
    WHERE subscriber_id = s.id AND type IN ('exit','reengagement')
  )
```

**B. Late dunning (queued payment-recovery emails)**

```sql
SELECT s.* FROM wb_churned_subscribers s
JOIN wb_customers c ON s.customer_id = c.id
WHERE c.activated_at IS NOT NULL
  AND c.stripe_subscription_id IS NOT NULL
  AND s.pause_drain_processed_at IS NULL
  AND s.dunning_state IN ('awaiting_retry','final_retry_pending')
  AND s.email IS NOT NULL
  AND s.do_not_contact = false
  AND s.created_at > NOW() - INTERVAL '180 days'
  AND (s.dunning_last_touch_at IS NULL
       OR s.dunning_last_touch_at < NOW() - INTERVAL '7 days')
```

**C. Late replies (queued win-back replies)**

```sql
SELECT s.* FROM wb_churned_subscribers s
JOIN wb_customers c ON s.customer_id = c.id
WHERE c.activated_at IS NOT NULL
  AND c.stripe_subscription_id IS NOT NULL
  AND s.pause_drain_processed_at IS NULL
  AND s.reply_text IS NOT NULL
  AND s.last_engagement_at IS NOT NULL
  AND s.last_engagement_at > NOW() - INTERVAL '180 days'
  AND s.email IS NOT NULL
  AND s.do_not_contact = false
  AND s.founder_handoff_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM wb_emails_sent
    WHERE subscriber_id = s.id
      AND type = 'followup'
      AND created_at > s.last_engagement_at
  )
```

### Decision logic per row

**For categories A + C (classifier-driven):**

1. Re-run `classifySubscriber` with `daysElapsedSinceEvent` added to
   `SubscriberSignals`. Internally a single number; for category A
   it's `daysSinceCancellation`, for category C it's `daysSinceReply`.
2. The classifier's prompt mentions this signal so the model can
   factor in time decay against the cancellation reason (a "missing
   feature" cancel decays faster than a "too expensive" one).
3. Use the returned outcomes:
   - `suppress=true` OR `tier=4` → skip; emit
     `pause_drain_processed` event with action=`skipped_classifier`
     and the reasoning text.
   - `handoff=true` → call `triggerFounderHandoff` (existing path);
     emit `pause_drain_processed` event with action=`handoff`.
   - Otherwise → call the normal send function. Send success → emit
     `pause_drain_processed` with action=`sent`.
4. **Regardless of outcome (send / skip / handoff): set
   `pause_drain_processed_at = NOW()` on the row.** This removes
   the row from the queue.

**For category B (template-driven):**

Dunning emails don't use the classifier. The cron just calls
`sendDunningEmail` or `sendDunningFollowupEmail` based on
`dunningTouchCount`. On send success: set `pause_drain_processed_at`.

### Failure recovery — the durability guarantee

The whole design rests on one invariant:

> **`pause_drain_processed_at` is set if and only if the row reached
> a terminal outcome (sent / suppressed / handoff).**

Three failure modes, and how they recover automatically:

1. **Anthropic / classifier outage during category A or C**
   - Caught per-row, logged, `pause_drain_processed_at` stays NULL.
   - Next cron tick re-enters the row in the filter.
   - When Anthropic recovers, the classifier runs.

2. **Resend outage during send**
   - Caught per-row, logged, `pause_drain_processed_at` stays NULL.
   - Next tick retries. The per-row idempotency check inside the
     send functions (via `wb_emails_sent`) ensures the same email
     never gets sent twice on a partial-failure retry.

3. **Cron tick crashes mid-batch (timeout, infra failure)**
   - Rows whose `pause_drain_processed_at` was already set (earlier
     in the batch) stay processed.
   - Rows the batch hadn't reached yet stay NULL, picked up next tick.
   - Rows the cron was mid-way through: at worst, the send fired
     but `pause_drain_processed_at` wasn't set → next tick retries,
     `wb_emails_sent` idempotency prevents a double-send, the retry
     sets the column.

Worst case for any one row: one wasted classification call OR one
wasted send attempt that returns "already sent" from the
idempotency layer. No double emails. No stuck rows.

### Cron cadence + per-tick budget

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/drain-paused-queue", "schedule": "*/5 * * * *" }
  ]
}
```

Every 5 minutes. Each tick processes up to 50 rows total across all
customers (combined budget across categories A + B + C). At 120ms
throttle per row that's ~6s, well under any function timeout.

If the backlog exceeds 50, the next tick continues. A 500-row
backlog across the platform drains in ~50 minutes — perfectly fine
since the user-perceived latency is "subscribe → first emails fire in
a few minutes."

### Schema — migration 034

One new column on `wb_churned_subscribers`:

```sql
ALTER TABLE wb_churned_subscribers
ADD COLUMN IF NOT EXISTS pause_drain_processed_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_wb_churned_subscribers_drain_queue
ON wb_churned_subscribers (customer_id, pause_drain_processed_at)
WHERE pause_drain_processed_at IS NULL;
```

The partial index supports the cron's filter efficiently — only
unprocessed rows are indexed.

### UX on `/billing/success`

No drain trigger from the success page — the cron is the only
trigger. But a single line of copy below the existing success text,
shown only when the customer has a non-empty queue at the moment
they land:

```
"You're subscribed."
"We'll bill $99/mo plus 1× MRR per recovered win-back…"

[ When queue is non-empty: ]
"We're now processing N events from your trial-paused window
 — X cancellations, Y failed payments, Z replies. Most will
 land in your dashboard within a few minutes."

[Back to dashboard →]
```

The counts come from a cheap COUNT(*) query on the three filters
above (the partial index keeps it fast). When all three counts are
zero, the line is omitted entirely.

### Observability

Two events emitted per drain run:

- `pause_drain_processed` (one per row): `{ customerId, subscriberId,
  category: 'cancellation' | 'dunning' | 'reply', action: 'sent' |
  'skipped_classifier' | 'handoff' | 'failed', reasoning?: string }`
- `pause_drain_tick_summary` (one per cron run): `{ rowsProcessed,
  sent, skipped, handoff, failed, durationMs }`

Both already covered by the existing `wb_events` infrastructure —
no new event types or schema.

## Code paths touched

| File | Change |
|---|---|
| `src/winback/lib/pause-drain.ts` | **new** — `processOneDrainItem(subscriber, category)`, `runDrainTick(limit)`, `getPausedQueueCounts(customerId)` |
| `src/winback/lib/types.ts` (or wherever `SubscriberSignals` lives) | Add `daysElapsedSinceEvent?: number` signal |
| `src/winback/lib/classifier.ts` | Update prompt template to mention the new signal; pass it through |
| `lib/schema.ts` | Add `pauseDrainProcessedAt` column on `churnedSubscribers` |
| `src/winback/migrations/034_pause_drain_processed_at.sql` | **new** migration with column + partial index |
| `app/api/cron/drain-paused-queue/route.ts` | **new** route handler — auth via `CRON_SECRET`, calls `runDrainTick(50)` |
| `vercel.json` | Add the cron schedule entry |
| `app/billing/success/page.tsx` | Call `getPausedQueueCounts` for the UX line; no drain trigger from here |
| `src/winback/__tests__/pause-drain.test.ts` | **new** — coverage for queue selection, per-row state, classifier-driven branches, send-failure retry semantics, dunning branch |

No webhook handler changes. No claim column on `customers`. No
`waitUntil`.

## Edge cases

- **Customer subscribes between cron ticks** → up to 5min wait
  before first emails fire. Acceptable; the success page copy sets
  expectation.
- **Customer subscribes during a cron tick already in progress** → cron
  processes any customer's rows it finds at query time. Our customer's
  rows get picked up on the next tick at the latest.
- **Drain finishes a customer's full queue, customer cancels +
  resubscribes** → second paused window accumulates a new queue with
  `pause_drain_processed_at` NULL again (these are fresh subscriber
  rows, never been processed). Next cron tick drains them. Good.
- **Customer cancels Stripe sub during a drain tick** → the
  `c.stripe_subscription_id IS NOT NULL` filter excludes their rows
  on subsequent ticks. Already-processed rows stay processed.
- **`founder_handoff_at` was set before drain reaches the row** →
  filter excludes; founder is already working it.
- **Subscriber was unsubscribed (`do_not_contact=true`) during paused
  window** → filter excludes; we respect their unsubscribe.
- **Pilot graduation** (`pilotUntil` was in the future, now past):
  pilot merchants bypassed the billing-pause gate entirely (no
  emails were blocked), so they have no queue. Cron picks 0 rows
  for them. No-op.
- **A single row keeps failing** (e.g., classifier always errors on
  it, malformed email field): retries every 5 min indefinitely. After
  N retries it'd be worth surfacing in admin events. For launch we
  don't auto-give-up — accept the per-row hammering and address it
  manually if it shows up in `wb_events`.
- **Resend rate limit hit** (10/s): the 120ms throttle stays under
  it. On a transient 429 from Resend, per-row catch logs and
  continues; next tick retries.
- **Cron service down on Vercel** (rare): drain pauses globally
  until restored. Subscribed customers' queues grow but stay safe;
  next tick processes everything.
- **No `wb_customers.pause_drained_at`** — deliberate. We removed it
  from v1 of this spec. The customer-level drain state is derivable
  by querying "any row with `pause_drain_processed_at IS NULL` for
  this customer?" If there are none, drain is done.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — new pause-drain tests + existing tests green
- [ ] Migration 034 applied to dev Neon branch before testing
- [ ] **Manual e2e on dev with seeded queue:**
  - [ ] Set up tejaasvi in paused state
  - [ ] Insert 3 mock cancellations (1 recent, 1 mid-age, 1 ~120 days old) with varying reasons
  - [ ] Insert 1 mock failed payment with `dunningState='awaiting_retry'`
  - [ ] Insert 1 mock reply on an existing subscriber (set `replyText`)
  - [ ] Subscribe via the normal flow → land on `/billing/success`
  - [ ] Confirm success page shows the "processing N events" line with correct counts (3+1+1=5 expected)
  - [ ] Trigger cron manually: `curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/drain-paused-queue`
  - [ ] Confirm: rows update statuses; recent cancellations have exit emails sent; the 120-day-old cancellation has classifier reasoning in the drawer; `pause_drain_processed_at` is set on each row that was processed
  - [ ] Re-run the cron immediately → 0 rows processed (filter excludes drained rows)
  - [ ] Confirm `wb_events`: `pause_drain_processed` per row + `pause_drain_tick_summary` per tick
- [ ] **Per-row failure recovery test:**
  - [ ] Mock the classifier to throw on the first row of a 5-row batch
  - [ ] Run the cron → 4 rows have `pause_drain_processed_at` set, 1 row stays NULL
  - [ ] Un-mock the classifier, run again → 1 row gets processed, 0 retries needed
- [ ] **Apply migration 034 to prod Neon main branch** before merging PR

## Out of scope

- Drain on second/third paused windows (resubscribe cycles). The
  per-row state correctly handles this naturally — fresh rows in
  a new paused window have `pause_drain_processed_at = NULL` and
  enter the queue. Earlier-drained rows from the prior window stay
  processed.
- Drain progress UI on the dashboard (live counters). Rows update as
  emails fire — that's the indicator.
- Re-running the classifier on items that already have a recent
  classification (within hours of cancellation). Optimization, not
  correctness — defer.
- Founder-triggered manual drain button. Useful if a row gets stuck;
  spec 50's compose helper already covers the "I'll handle this one
  myself" recovery path.
- Differential drain semantics for different cancellation reasons.
  The classifier sees both `cancellationReason` and `changelog`
  already; should make this judgment without special-casing.
- Vercel Queues / Inngest / dedicated job runner. Cron + per-row
  state is sufficient for the launch context. Revisit if drain
  reliability shows up as a problem in practice.
- Classifier prompt rewrite beyond adding the `daysElapsedSinceEvent`
  signal. Bigger classifier changes are their own spec.

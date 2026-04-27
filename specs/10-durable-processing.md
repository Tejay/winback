# Spec 10 — Durable Event Processing (DB-Backed Queue)

> **⚠️ Superseded for now (2026-04-27)** — [Spec 28](28-targeted-reliability-fix.md)
> ships the targeted fixes (email-level idempotency, find-or-resend in
> webhook handlers, 429-aware retry wrapper) that close the actual
> stuck-pending bug at a fraction of this spec's surface area. This
> queue + cron + dispatcher design stays here as the system to build
> when traffic warrants it. **Build the full design when any of these
> trigger thresholds fire:**
>
> - 🚨 A real customer's churn email is lost in production (one is enough)
> - 📈 Webhook p95 latency >10s in production for a sustained day
> - 🔁 Anthropic 429s appear in `wb_events` more than once per week
> - 📊 Volume sustained >1k events/day for a full week
>
> The async-webhook + waitUntil pattern in Part B specifically depends
> on the cron safety net in Part D — they're not separable. Don't
> implement just async webhook without the cron, or you'll add a silent-
> loss-on-crash failure mode.

**Phase:** 11
**Depends on:** Spec 04 (webhook handler), Spec 05 (dashboard), Spec 09 (dunning)
**Estimated time:** ~2 days

---

## Context

Today the Stripe webhook handler processes churn events **inline**: verify signature → insert subscriber row → call LLM → call Resend → return 200. If the LLM or Resend times out or the function crashes mid-way, the subscriber can be stuck in `pending` forever because the existing idempotency check skips any row that already exists.

This spec introduces a **DB-backed queue** pattern that:

1. **Never loses messages** — INSERT happens before Stripe gets 200, and retries are status-aware
2. **Doesn't let functions die** — webhook returns 200 fast via `waitUntil()`; actual work runs in parallel worker functions
3. **Respects downstream rate limits** — Anthropic, Resend, Stripe capped via concurrency
4. **Doesn't burden the DB** — partial indexes keep the working set small, archival removes old rows
5. **Is observable on screen** — dashboard "Stuck" tab shows rows that keep failing
6. Adds **idempotency at the email level** so retries never double-send
7. **Never gives up** — emails aren't time-sensitive, so if LLM/Resend is down for 2 hours, we queue and keep retrying until they're back

Tested target: **scales cleanly to ~100k events/day**, with fan-out architecture to reach ~500k/day without redesign.

---

## Part A — Schema changes

### A.1 Extend `wb_churned_subscribers`

Add columns for queue state:

```sql
ALTER TABLE wb_churned_subscribers
  ADD COLUMN attempts       int         NOT NULL DEFAULT 0,
  ADD COLUMN last_error     text,
  ADD COLUMN next_retry_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN locked_at      timestamptz;
```

Expand the `status` values (column is already `text`, no DDL needed):

| Status | Meaning |
|---|---|
| `pending` | Row inserted, awaiting processing (may have retried many times) |
| `processing` | Worker has claimed this row (locked_at is set) |
| `contacted` | Email sent successfully — terminal happy path |
| `recovered` | Subscriber re-subscribed — terminal happy path |
| `lost` | LLM suppressed (tier 4, no email) — terminal |

**Note:** no `error` status. Rows keep retrying forever with capped backoff. If downstream is down for hours, rows wait patiently. The only terminal failure is human intervention (marking a row `lost` manually from the dashboard).

### A.2 Partial index

```sql
CREATE INDEX idx_subscribers_queue
  ON wb_churned_subscribers (next_retry_at)
  WHERE status = 'pending';
```

This is the single most important index: it keeps the queue-scan query fast regardless of total table size.

### A.3 Email-level idempotency

```sql
CREATE UNIQUE INDEX idx_emails_sent_unique
  ON wb_emails_sent (subscriber_id, type);
```

Prevents duplicate `exit` / `dunning` / `win_back` emails to the same subscriber even if worker retries. One email per (subscriber, type) — ever.

### A.4 Safe-defaults migration for existing rows

Existing rows will default to `attempts = 0`, `next_retry_at = now()`, `locked_at = null`. Rows already in `contacted`/`recovered`/`lost` are terminal and ignored by the queue — no backfill needed.

---

## Part B — Webhook refactor: decouple ingest from processing

**File:** `app/api/stripe/webhook/route.ts`

Rewrite the handler so it does the minimum synchronously and returns 200 fast:

```typescript
import { waitUntil } from '@vercel/functions'

export async function POST(req: Request) {
  // 1. Verify signature (synchronous, fast)
  const event = verifyStripeSignature(req)

  // 2. Insert a row with status = 'pending', minimal fields only
  //    No LLM call, no Resend call, no Stripe API call here
  const subscriberId = await enqueueEvent(event)

  // 3. Fire the worker in background so Stripe gets 200 immediately
  if (subscriberId) {
    waitUntil(processSubscriber(subscriberId))
  }

  return new Response('ok', { status: 200 })
}
```

**`enqueueEvent(event)`** handles the 5 current event types. For `customer.subscription.deleted` and `invoice.payment_failed` it **just inserts a row** (no signal extraction, no LLM). For recovery events (`subscription.created`, `checkout.session.completed`, `invoice.payment_succeeded`) it can still process inline because they're cheap DB-only operations.

The expensive work (`extractSignals`, `classifySubscriber`, `scheduleExitEmail`) moves to the worker.

### Guarantee: no message lost

The row INSERT commits before the function returns 200. If the function dies after INSERT but before `waitUntil` fires, the cron will pick up the row 60s later (it's still `pending`). If Stripe never gets 200, it retries; the new idempotency check on `(customer_id, stripe_customer_id, cancellation_reason)` skips the insert but still schedules the worker.

---

## Part C — Worker route

**New file:** `app/api/internal/process-subscriber/[id]/route.ts`

Handles a single subscriber end-to-end:

```typescript
export async function POST(req: Request, { params }) {
  const { id } = await params
  const secret = req.headers.get('x-internal-secret')
  if (secret !== process.env.CRON_SECRET) return new Response('Forbidden', { status: 403 })

  // 1. Atomic claim: status pending → processing (only if next_retry_at <= now)
  const row = await claimSubscriber(id)
  if (!row) return new Response('Not claimable', { status: 200 })

  try {
    // 2. Do the work
    await runPipeline(row)
    await markContacted(id)
  } catch (err) {
    await recordFailure(id, err)
  }

  return new Response('ok', { status: 200 })
}
```

**`claimSubscriber(id)`** uses `FOR UPDATE SKIP LOCKED`:

```sql
UPDATE wb_churned_subscribers
SET status = 'processing', locked_at = now(), attempts = attempts + 1
WHERE id = $1
  AND status = 'pending'
  AND next_retry_at <= now()
RETURNING *
```

If the row isn't claimable (already processing, or retry not due yet), worker exits cleanly.

**`runPipeline(row)`** is the extracted churn processing:
- decrypt token → `extractSignals` → `classifySubscriber` → `scheduleExitEmail`
- For dunning rows (cancellation_reason = 'Payment failed'), runs `sendDunningEmail` instead

**`recordFailure(id, err)`** sets exponential backoff, capped at 60 min:

```typescript
const delayMins = Math.min(60, 2 ** row.attempts)  // 2, 4, 8, 16, 32, 60, 60, 60...
await db.update(churnedSubscribers).set({
  status: 'pending',               // stays pending forever, no give-up state
  last_error: String(err).slice(0, 2000),
  next_retry_at: new Date(Date.now() + delayMins * 60_000),
  locked_at: null,
})
```

No max attempts. If LLM/Resend is down for 2 hours, the row waits and retries when they're back. Once backoff tops out at 60 min, that becomes the steady retry cadence until success. `last_error` always reflects the most recent failure for dashboard visibility.

Route is protected by `CRON_SECRET` so only the cron and dashboard can trigger it.

---

## Part D — Cron dispatcher

**New file:** `app/api/cron/dispatch-queue/route.ts`

Runs every minute. Does **not** process rows — only dispatches them to worker invocations.

```typescript
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Forbidden', { status: 403 })
  }

  // 1. Claim up to N rows (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 40)
  const dueRows = await db.execute(sql`
    SELECT id FROM wb_churned_subscribers
    WHERE status = 'pending'
      AND next_retry_at <= now()
    ORDER BY next_retry_at
    LIMIT 40
    FOR UPDATE SKIP LOCKED
  `)

  // 2. Fan out: one HTTP call per row (fire-and-forget)
  const base = process.env.NEXT_PUBLIC_APP_URL
  await Promise.allSettled(dueRows.map(r =>
    fetch(`${base}/api/internal/process-subscriber/${r.id}`, {
      method: 'POST',
      headers: { 'x-internal-secret': process.env.CRON_SECRET! },
    })
  ))

  // 3. Zombie reaper: reset 'processing' rows stuck > 10 min
  await db.execute(sql`
    UPDATE wb_churned_subscribers
    SET status = 'pending', locked_at = null
    WHERE status = 'processing' AND locked_at < now() - interval '10 minutes'
  `)

  return Response.json({ dispatched: dueRows.length })
}
```

**Throughput math:** 40 rows/min × parallel workers = ~58k/day dispatch capacity. Batch size chosen to stay comfortably under Anthropic Haiku Tier 2 (50 RPM). Raise to 100+ when on Tier 3 (1000 RPM).

### D.1 Cron config via `vercel.ts`

Replace the empty `vercel.json` with a `vercel.ts`:

```typescript
// vercel.ts
import { type VercelConfig } from '@vercel/config/v1'

export const config: VercelConfig = {
  crons: [
    { path: '/api/cron/dispatch-queue', schedule: '* * * * *' }, // every minute
  ],
}
```

---

## Part E — Rate limiting (LLM + Resend + Stripe)

### E.1 Concurrency cap at the fan-out layer

The cron dispatches up to 100 rows per run. Each row hits **Anthropic (1)**, **Stripe API (2–4)**, and **Resend (1)** — roughly 5–7 downstream calls per worker.

Anthropic Haiku Tier 2 = 50 RPM. To stay under that at 100/min dispatch rate we'd exceed 2× the limit. Mitigation:

- **Batch size capped at 40 per dispatch tick** (well under 50 RPM for Anthropic)
- Each worker has 1 LLM call, so 40 workers/min = 40 RPM ≪ 50 RPM

If we reach Tier 3 (1000 RPM) we can raise the cap.

### E.2 429-aware client retry

Update `classifySubscriber`, `sendEmail`, and Stripe calls to respect `retry-after` header on HTTP 429:

```typescript
async function callWithRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try { return await fn() } catch (err) {
      if (err.status === 429 && err.headers?.['retry-after']) {
        await sleep(Number(err.headers['retry-after']) * 1000)
        continue
      }
      throw err
    }
  }
}
```

This is a lightweight addition to the existing SDK clients. No shared state (Redis) needed at current scale.

### E.3 Graceful failure path

If LLM or Resend errors, the worker calls `recordFailure` which schedules retry with exponential backoff (up to 60 min). The row stays `pending` forever until it succeeds or a human marks it `lost`. Consistent with the design principle: **emails are not time-sensitive; retry patiently**.

If a downstream service is down for 2 hours, rows accumulate waiting. When the service comes back, the cron drains them within minutes (subject to batch-size throttling).

---

## Part F — Dashboard: "Stuck" view

**File:** `app/dashboard/dashboard-client.tsx`

Add a filter option `"Stuck"` alongside the existing `all | pending | contacted | recovered | lost`. A row is "stuck" if `status = 'pending' AND attempts > 3 AND last_error IS NOT NULL` — meaning it's failed at least 3 times and is still retrying.

**File:** `app/api/subscribers/route.ts`
Support `filter=stuck` → the WHERE clause above.

### UI

Stuck rows show extra columns:
- **Attempts**: `attempts` (e.g. "7")
- **Last error**: truncated `last_error` (tooltip for full text)
- **Next retry**: human-readable relative time (e.g. "in 12 min")

**Retry now button** per row: POSTs to `/api/subscribers/[id]/retry` which:
```sql
UPDATE wb_churned_subscribers
SET attempts = 0, next_retry_at = now(), last_error = null
WHERE id = $1
```

Cron picks it up within 60s. Useful to force-retry immediately rather than wait for backoff.

**Mark as lost button** per row: POSTs to `/api/subscribers/[id]/mark-lost` which sets `status = 'lost'`. For rows that are genuinely broken (bad data, etc.) and will never succeed.

### Header badge

Top of dashboard shows count of stuck rows: e.g. "⚠️ 3 stuck" with amber background, clickable to the Stuck filter. If 0, badge is hidden. This is the "screen-only" observability — founder sees it when they open the dashboard.

---

## Part G — Archival (keep the hot set small)

**Not urgent** — can defer to when table exceeds ~100k rows. Design sketch:

Daily cron (`0 3 * * *`) moves rows in terminal states older than 90 days to `wb_churned_subscribers_archive`. Not implemented in this spec, but the partial index means this can be deferred safely — even at 10M rows, the index stays small.

---

## Files to create / modify

**Create:**
- `app/api/internal/process-subscriber/[id]/route.ts` — worker
- `app/api/cron/dispatch-queue/route.ts` — dispatcher
- `app/api/subscribers/[id]/retry/route.ts` — manual retry now
- `app/api/subscribers/[id]/mark-lost/route.ts` — manual mark-lost
- `src/winback/lib/queue.ts` — `claimSubscriber`, `recordFailure`, `runPipeline`
- `src/winback/__tests__/queue.test.ts` — unit tests for claim/failure logic
- `vercel.ts` — replace `vercel.json` with cron config
- `src/winback/migrations/002_queue.sql` — schema migration

**Modify:**
- `app/api/stripe/webhook/route.ts` — rewrite `processChurn` to enqueue only; add `waitUntil`
- `lib/schema.ts` — add `attempts`, `last_error`, `next_retry_at`, `locked_at`
- `app/dashboard/dashboard-client.tsx` — stuck filter, stuck columns, retry + mark-lost buttons, stuck badge
- `app/api/subscribers/route.ts` — support `filter=stuck`
- `src/winback/lib/classifier.ts` + `email.ts` — add 429 retry wrapper

**Existing to reuse:**
- `extractSignals` (`src/winback/lib/stripe.ts`)
- `classifySubscriber` (`src/winback/lib/classifier.ts`)
- `scheduleExitEmail`, `sendDunningEmail`, `sendEmail` (`src/winback/lib/email.ts`)
- `decrypt` (`src/winback/lib/encryption.ts`)

---

## Verification

### Unit
- `npx vitest run` — new tests in `queue.test.ts` cover:
  - Claim succeeds only when `status = 'pending' AND next_retry_at <= now()`
  - `recordFailure` correctly sets exponential backoff (caps at 60 min)
  - Retry keeps incrementing `attempts` forever (no max-attempts cap)
  - Manual retry endpoint resets `attempts = 0` and `next_retry_at = now()`

### Integration (local)
Synthetic test script `scripts/queue-load.ts`:
```
1. Insert 50 synthetic pending rows for a test customer
2. Hit /api/cron/dispatch-queue manually (with CRON_SECRET)
3. Poll DB every 10s — all should be contacted within 2 min
4. Introduce a row with email = null → verify it keeps retrying with backoff, lands in "stuck" dashboard view
5. Simulate LLM outage (set ANTHROPIC_API_KEY to bad value briefly) → verify rows queue up, then drain when fixed
```

### End-to-end (preview deploy)
1. Deploy to preview branch
2. Use Stripe CLI to trigger real `customer.subscription.deleted` on test account
3. Check Vercel logs — webhook returns 200 in <500ms
4. Worker logs show `extractSignals → classify → send` trace
5. Row reaches `status = 'contacted'` within 90s

### TypeScript
- `npx tsc --noEmit` — must pass before merge per CLAUDE.md rule

---

## Open questions / deferred

- **Archival** (Part G) — deferred until volume warrants. Partial index buys time.
- **Template fallback when LLM down for hours** — explicitly not doing this. Emails are not time-sensitive; rows queue and retry until downstream recovers.
- **Push alerts** — explicitly out of scope. Screen-only observability via dashboard.
- **Multi-region** — deferred; single region is fine at current scale.
- **Stripe event ID deduplication** — relies on current business-key idempotency (`customer_id + stripe_customer_id`). If Stripe ever double-delivers a webhook faster than the first INSERT commits, we'd get duplicates. Mitigation would be storing `event.id` and unique-constraining it; skip for now, revisit if observed.

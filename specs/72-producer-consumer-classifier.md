# Spec 72 — Producer/consumer backfill + classifier

## Context

Two unrelated operations are bundled together in our hot paths today:

1. **Stripe ingest** — pulling raw subscription data (Stripe API,
   pagination, signal extraction)
2. **LLM classification + email send** — calling Anthropic to assign a
   tier / triggerNeed / etc., then conditionally sending an exit email

Both run synchronously, end-to-end, inside two surfaces:

- `customer.subscription.deleted` webhook (real-time path)
- `backfillCancellations()` (initial bulk import on Stripe connect)

The bundling has two compounding problems:

1. **Failure cascades** — Anthropic outage stalls Stripe ingest, and
   vice versa. They share a process; one's bad day kills both.
2. **Vercel 300s function ceiling** — a merchant with 200+ historical
   cancellations × ~1.5s LLM call/row blows past the cap. Vercel kills
   the process silently. No `catch` runs. The customer row sits in
   "started but never completed" forever, the merchant complains
   3 days later, support manually fixes via CLI.

We've also been thinking about a 60-second exit-email SLA. The user
explicitly relaxed this requirement during the design conversation —
eventual delivery (within a few minutes) is acceptable.

This spec re-architects the pipeline into a producer/consumer model
with two independent crons, fully embraces eventual classification,
and ships dashboard status messaging so merchants see progress.

## Goals

1. **Separate ingest from classification.** Two distinct processes
   with independent failure modes. One can be broken while the other
   keeps running.
2. **Backfill becomes resumable.** Vercel timeout no longer means
   silent failure — the cron picks up where the previous tick stopped.
3. **Webhook hot path drops the LLM call.** Webhook handler just
   inserts a raw row and returns. Classification + exit email happen
   later on a cron tick.
4. **Coordination via DB.** Atomic claim/release lock on
   `wb_customers` rows so fire-and-forget + cron can't double-process.
5. **Status visible to merchant.** Dashboard message reflects
   "importing… 47 imported so far" → "all 213 imported" without
   exposing internals.
6. **Cron-health widget gets two new rows for free** — already wired
   to read `cron_run` events (Spec 69).

## Non-goals

- **Dashboard pagination.** A separate concern; merchants with very
  large lists need it but it's not part of this refactor.
- **Per-improvement match quality (#23).** Separate /reasons-page
  spec.
- **Inbound webhook idempotency changes.** Spec 64's reservation
  pattern is untouched.
- **Pre-aggregate totals.** We won't know "how many total subscribers
  will be imported" until Stripe pagination ends. Status shows running
  counts without denominators; that's fine.
- **Replay/reclassify of existing rows.** Existing classified rows
  stay as-is. The new `classified_at` column gets backfilled to
  `updated_at` for them.

## Silent-churn ask email (added during implementation)

Silent-churn previously got `firstMessage: null` from `classifySilentChurn()` — no exit email ever went out, even though they're the largest segment (90% of typical merchant cohort per the load test's tier distribution). That was a missed signal opportunity: every cancellation is a chance to ask "why?", and reply rate even at 5-15% is hugely valuable when scaled across the silent pool.

The classifier-tick now populates `firstMessage` for silent-churn rows with a deterministic template (no LLM call):

```
Subject: A quick question, {firstName}

Hi {firstName},

Saw you cancelled {productName} recently. If you have a minute, I'd love
to know what didn't land. Even one line is enough — I read every reply.

— {founderName}
```

The word "recently" is deliberate — no specific date reference, so the same copy works at 5 days post-cancel as at 80 days. That lets us widen the recency window to 90 days for silent churn (vs 7 days for signal-bearing exit emails, which DO reference specifics and feel stale after a week). Two recency constants in the file: `EXIT_EMAIL_RECENCY_DAYS = 7` and `SILENT_CHURN_RECENCY_DAYS = 90`.

When a subscriber replies, the inbound webhook re-classifies with the new text → tier potentially flips to 1/2 → re-engagement opportunity opens.
- **Backwards compat with the 60-second exit-email SLA.** Explicitly
  relaxed.

## Schema

**`wb_customers` (migration 042)** — pagination + lock + cursor:

```sql
ALTER TABLE wb_customers
  ADD COLUMN backfill_cursor TEXT,                    -- Stripe `starting_after` id
  ADD COLUMN backfill_processing_at TIMESTAMPTZ;      -- atomic claim lock
```

(`backfill_started_at`, `backfill_completed_at`, `backfill_processed`
already exist.)

**`wb_churned_subscribers` (migration 042)** — pending classification:

```sql
ALTER TABLE wb_churned_subscribers
  ADD COLUMN classified_at      TIMESTAMPTZ,   -- NULL = waiting for classifier
  ADD COLUMN classify_attempts  INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_wb_churned_subscribers_pending_classify
  ON wb_churned_subscribers (created_at)
  WHERE classified_at IS NULL;
```

**One-time data backfill** (idempotent SQL in the migration):

```sql
-- Existing classified rows: mark them done so the classifier cron
-- doesn't re-process them.
UPDATE wb_churned_subscribers
SET classified_at = COALESCE(updated_at, created_at)
WHERE tier IS NOT NULL AND classified_at IS NULL;
```

**Compound uniqueness on the dedup pair** (closes the race-with-webhook
gap discussed during design):

```sql
CREATE UNIQUE INDEX idx_wb_churned_subscribers_customer_stripe
  ON wb_churned_subscribers (customer_id, stripe_customer_id);
```

## The two crons

### `/api/cron/backfill-ingest` (every 5 minutes)

Picks customers whose backfill is in progress; one tick per customer.

```ts
async function backfillIngestTick(customerId: string): Promise<TickResult> {
  // 1. Atomic claim — stale-lock recovery at 10 min
  const [claimed] = await db
    .update(customers)
    .set({ backfillProcessingAt: new Date() })
    .where(and(
      eq(customers.id, customerId),
      isNull(customers.backfillCompletedAt),
      or(
        isNull(customers.backfillProcessingAt),
        sql`backfill_processing_at < NOW() - INTERVAL '10 min'`,
      ),
    ))
    .returning({ cursor: customers.backfillCursor, /* ... */ })
  if (!claimed) return { kind: 'skipped', reason: 'claim_failed' }

  // 2. Pull next Stripe page using claimed.cursor as starting_after
  const stripe = getConnectStripe(decrypt(customer.stripeAccessToken))
  const page = await stripe.subscriptions.list({
    status: 'canceled',
    limit: 100,
    starting_after: claimed.cursor ?? undefined,
  })

  // 3. INSERT raw rows (idempotent — UNIQUE index + ON CONFLICT DO NOTHING)
  for (const sub of page.data) {
    const signals = await extractSignals(sub, accessToken)
    await db.insert(churnedSubscribers)
      .values({
        customerId,
        stripeCustomerId: signals.stripeCustomerId,
        stripeSubscriptionId: signals.stripeSubscriptionId,
        stripePriceId: signals.stripePriceId,
        email: signals.email,
        name: signals.name,
        planName: signals.planName,
        mrrCents: signals.mrrCents,
        tenureDays: signals.tenureDays,
        everUpgraded: signals.everUpgraded,
        nearRenewal: signals.nearRenewal,
        paymentFailures: signals.paymentFailures,
        previousSubs: signals.previousSubs,
        stripeEnum: signals.stripeEnum,
        stripeComment: signals.stripeComment,
        cancelledAt: signals.cancelledAt,
        source: 'backfill',
        status: 'pending',         // classifier will refine
        classifiedAt: null,        // NULL = needs classification
      })
      .onConflictDoNothing()
  }

  // 4. Update cursor + release lock atomically
  if (page.has_more) {
    await db.update(customers).set({
      backfillCursor: page.data[page.data.length - 1].id,
      backfillProcessed: sql`backfill_processed + ${page.data.length}`,
      backfillProcessingAt: null,
    }).where(eq(customers.id, customerId))
    return { kind: 'progress', rowsThisTick: page.data.length }
  } else {
    await db.update(customers).set({
      backfillCompletedAt: new Date(),
      backfillProcessed: sql`backfill_processed + ${page.data.length}`,
      backfillProcessingAt: null,
    }).where(eq(customers.id, customerId))
    return { kind: 'completed', rowsThisTick: page.data.length }
  }
}
```

The cron entrypoint just calls this for every customer with backfill
in progress (one tick per customer per scheduled fire).

### `/api/cron/classifier` (every 2 minutes)

Picks unclassified rows in batches. Sized to fit a Vercel tick budget.

```ts
// Note: BATCH was 30 in the original draft; load testing showed
// Anthropic latency is ~4-5s/call (not ~1.5s). Worst-case all-signal
// batches at 30 took ~145s — too close to a Vercel 60s default. After
// the load test we set maxDuration = 300 on the route and BATCH = 20.
const BATCH_PER_TICK = 20   // ~20 × 5s = 100s worst case, safely under 300s ceiling

async function classifierTick(): Promise<TickResult> {
  const rows = await db.select().from(churnedSubscribers)
    .where(and(
      isNull(churnedSubscribers.classifiedAt),
      lt(churnedSubscribers.classifyAttempts, 3),     // dead-letter at 3 failures
    ))
    .orderBy(asc(churnedSubscribers.createdAt))
    .limit(BATCH_PER_TICK)

  for (const row of rows) {
    try {
      const classification = await classifySubscriber(signals, ctx)
      await db.update(churnedSubscribers)
        .set({
          ...classifiedFields(classification),
          classifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(churnedSubscribers.id, row.id))

      // Downstream actions (was inline in webhook today):
      const isRecent = row.cancelledAt && (Date.now() - row.cancelledAt.getTime()) < 7 * 24 * 60 * 60 * 1000
      if (classification.tier !== 4 && isRecent && row.email) {
        await scheduleExitEmail({ ... })
      }
      // Handoff notification etc — same code paths as today
    } catch (err) {
      await db.update(churnedSubscribers)
        .set({ classifyAttempts: sql`classify_attempts + 1` })
        .where(eq(churnedSubscribers.id, row.id))
      logEvent({ name: 'classify_failed', ... })
      // After 3 attempts, this row falls out of the WHERE clause and
      // a `classify_dead_lettered` event surfaces in /admin/events.
    }
  }
}
```

## Code paths touched

### Schema + migrations

- `lib/schema.ts` — add the new columns + index types
- `src/winback/migrations/042_producer_consumer.sql` — schema changes + data backfill

### Cron entrypoints

- `app/api/cron/backfill-ingest/route.ts` (new) — wraps `withCron('backfill-ingest', ...)`. Picks customers with `started_at SET AND completed_at NULL`, calls `backfillIngestTick(customerId)` for each (up to N per cron fire to fit timeout).
- `app/api/cron/classifier/route.ts` (new) — wraps `withCron('classifier', ...)`. Calls `classifierTick()`.
- `vercel.json` — add both crons.
- `lib/cron-schedules.ts` — add display name + purpose + stale-impact entries so the cron-health widget renders them.

### Core logic

- `src/winback/lib/backfill.ts` — refactor `backfillCancellations()` into:
  - `runBackfillIngestTick(customerId)` — one-page-per-tick, exported
  - The OAuth callback's fire-and-forget still calls this; just runs the first 1-2 ticks before returning.
- `src/winback/lib/classifier-tick.ts` (new) — the consumer; pulls unclassified rows, classifies, runs downstream actions. Extracted from what currently lives inline in the webhook handler.

### Webhook handler

- `app/api/stripe/webhook/route.ts` — `customer.subscription.deleted` branch:
  - **Before**: inline extractSignals → classify → insert row → maybe send exit email
  - **After**: extract signals → INSERT raw row with `classifiedAt = NULL` → return 200. The classifier cron handles the rest within ~2 min.

The webhook becomes thin. All downstream effects (exit email, handoff
notification, etc.) move to `classifierTick`.

### OAuth callback (fire-and-forget kick)

- `app/api/stripe/callback/route.ts` — instead of `fetch('/api/backfill/start')`, the callback:
  1. Sets `backfill_started_at = NOW()` on the customer row.
  2. Fires `/api/backfill/start` (still fire-and-forget) which now calls `runBackfillIngestTick` up to ~2 times for fast first-impression (~200 rows in <60s).
  3. Cron picks up the rest on subsequent ticks.

The fire-and-forget cap (2 ticks ≈ 200 rows) keeps the OAuth callback's
function invocation under Vercel's ceiling. Anything beyond that waits
for the cron.

### Dashboard status messaging

- `app/dashboard/page.tsx` — read `backfill_started_at` + `backfill_completed_at` + `backfill_processed` from the customer row; render one of three states:
  - Not started: (nothing — Stripe not connected, separate flow)
  - In progress: "Importing your subscribers… 47 imported so far. The rest will appear shortly."
  - Completed: (no banner)
- Plus a secondary state for classification queue depth: "47 imported, 23 classified (the AI is working through them)" — shown only when there's a meaningful queue.

### Inspector + admin

- `/admin/subscribers` and `/admin/subscribers/[id]` — add a small badge for `classifiedAt IS NULL` rows: "pending classification." Subtle, doesn't change the layout.
- `wb_events` gets new names: `backfill_row_inserted`, `classify_failed`, `classify_dead_lettered`, `subscriber_classified`. Surfaces in the existing events page.

### Dead-letter monitoring

- **`/admin` Overview tile — "Dead-lettered rows"**: a small counter
  card next to the existing red-lights / cron-health sections. Shows
  total rows where `classified_at IS NULL AND classify_attempts >= 3`.
  Click → events page filtered to `classify_dead_lettered`.
  Implementation: one query in the Overview API route, one tile in
  the client.
- **Inspector banner on dead-lettered rows**: when the row's
  `classify_attempts >= 3` AND `classified_at IS NULL`, render a red
  banner above the existing sections: "⚠ Classification failed 3
  times. Last error: <message>. [Reset attempts]". Button POSTs to a
  new admin action that clears `classify_attempts` back to 0 (cron
  picks it up on next tick). Audit-logged.
- **New endpoint**: `POST /api/admin/subscribers/[id]/reset-classify`
  — requireAdmin, sets `classify_attempts = 0`, logs `admin_action`
  with action `reset_classify_attempts`.

## Edge cases

- **Vercel kills a tick mid-run.** Lock stays held until 10-min stale recovery. Next tick claims, picks up at the persisted cursor. Rows already inserted are skipped by the UNIQUE-index dedup.
- **Two crons fire simultaneously for the same customer.** Atomic UPDATE means only one wins. The other gets `null` from the claim, exits silently.
- **Stripe API returns `has_more: true` with zero data.** Cursor advances, next page tried. No infinite loop because Stripe will eventually return empty.
- **Backfill cursor points to a subscription that was deleted/changed since.** Stripe's `starting_after` is by ID, not data — still works. Worst case we get an extra page; idempotency catches the dupes.
- **Webhook arrives for a subscriber being backfilled at the same moment.** Compound UNIQUE `(customer_id, stripe_customer_id)` constraint + ON CONFLICT DO NOTHING. First insert wins; second is a no-op.
- **Classifier dead-letters a row after 3 attempts.** `classify_dead_lettered` event is fired. Admin sees in /admin/events. Row stays `classifiedAt = NULL` but invisible to the cron's WHERE clause. Manual investigation; support can reset `classify_attempts = 0` to retry once the bug is fixed.
- **Customer disconnects Stripe mid-backfill.** Subsequent ingest ticks would 401 on decrypt → tick logs error, releases lock, continues. Other customers unaffected. The OAuth-revoked customer's backfill resumes when they reconnect (resets `accountChanged` path).
- **Exit email arrives "late"** (e.g., subscriber cancelled 3 min ago, classifier hasn't fired yet). Email goes out within ~2 min of cancellation. Acceptable given the relaxed SLA.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — add tests:
  1. `runBackfillIngestTick` claims the lock atomically; concurrent ticks see no rows from claim and exit
  2. `runBackfillIngestTick` advances cursor on `has_more: true`; sets `completed_at` on `has_more: false`
  3. Stale-lock recovery: row with `processing_at > 10 min ago` is claimable
  4. `classifierTick` batches at most BATCH_PER_TICK rows
  5. `classifierTick` increments `classify_attempts` on classifier throw, logs `classify_failed`
  6. After 3 attempts, row drops out of the WHERE clause + `classify_dead_lettered` event emitted
  7. Webhook handler inserts raw row with `classified_at = null` and does NOT call classifier inline
  8. UNIQUE compound index rejects duplicate `(customer_id, stripe_customer_id)` insert
  9. `POST /reset-classify` zeroes classify_attempts + logs admin_action
- [ ] Manual smoke on dev:
  - Apply migration 042
  - Drop a fresh test customer with no Stripe connection; connect; verify dashboard shows "Importing… 0 imported" within seconds
  - Curl backfill-ingest cron a few times; watch counts climb
  - Curl classifier cron a few times; watch `classifiedAt` get set on rows
  - Verify exit emails fire for recent cancellations (sent during classifier tick, not at insert time)
  - Verify cron-health widget shows both new crons green
- [ ] Apply migration 042 to dev Neon (no prod yet — pre-launch)

## Phasing

One PR (large, but coherent). Estimated 1000–1200 LOC including
migration, tests, and dashboard messaging.

## Rollback

- Migration is additive (two new columns + a data backfill UPDATE) plus
  a new UNIQUE index. None of these are destructive.
- If we revert the code PR, both crons stop firing. Already-classified
  rows are unaffected. Unclassified rows would sit forever with
  `classifiedAt = NULL` — they'd need either the cron to come back OR
  a manual classifier run.
- Easiest revert path: revert the code PR but keep the migration
  applied. Re-run a one-shot script that classifies pending rows.

## Open questions resolved during design

1. **60-second exit email SLA** — relaxed to "within a few minutes."
2. **Pre-classified row count for status** — we don't pre-count; status
   shows running progress only, denominator appears only on completion.
3. **Pagination of merchant dashboard** — separate spec.
4. **Two crons or one combined?** — two independent crons so failure
   modes don't cross-contaminate (Stripe failures don't stall the LLM
   queue; Anthropic failures don't stall ingest).
5. **Fire-and-forget cap on connect** — ~200 rows (2 cron-tick
   equivalents) inline for fast first impression; cron continues from
   row 201+.

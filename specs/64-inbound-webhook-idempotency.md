# Spec 64 — Inbound webhook idempotency

**Status:** draft, awaiting approval.
**Scope:** the Resend inbound (`email.received`) webhook at
[app/api/email/inbound/route.ts](../app/api/email/inbound/route.ts).
**Out of scope:** Stripe webhook idempotency (separate concern, partially
in place); idempotency for other future inbound sources.

## Context

The inbound webhook has no replay protection. If Resend retries a
delivery (network blip, our 500, transient Vercel error, etc.) the same
`email_id` is processed twice. On the second pass:

1. The subscriber's `replyText` is overwritten with the same value (harmless).
2. `classifySubscriber` runs again — ~\$0.003 LLM cost, wasted.
3. `sendReplyEmail` may send a **second auto-reply to the subscriber** —
   visible, annoying, and undermines our "the AI feels like a human"
   product promise.

The gap was surfaced during Spec 63 sweep A while writing
`inbound-threading.test.ts`; deferred there to keep that PR test-only.

Resend's documented retry behaviour is exponential backoff up to ~24
hours on 5xx responses. The current hot-path crashes on a literal
`null` body (fixed separately in [PR #92](https://github.com/Tejay/winback/pull/92))
would trip this retry loop, so this idempotency layer is also a
defence-in-depth measure for any future hot-path bug.

## Goals

1. A second webhook delivery with the same Resend `email_id`
   short-circuits before any DB mutation, classifier call, or outbound
   email.
2. Race-safe: two near-simultaneous deliveries of the same `email_id`
   (e.g. a Resend retry overlapping with the original) result in
   exactly one being processed — the other gets a clean
   `already_processed` 200.
3. Observable: we can answer "have we seen this `email_id` before?
   when? what did we do with it?" from the database, with a primary-key
   point lookup.
4. Zero behaviour change for first-time inbounds — unique `email_id`s
   process exactly as they do today.

## Non-goals

- Replay protection for the Stripe webhook. Stripe's
  `customer.subscription.deleted` is partially deduped by other means
  (status flags, `wb_emails_sent` unique constraint). Out of scope.
- Indefinite retention. Old `wb_inbound_events` rows can be pruned by a
  cron after 90 days. Not in this spec; add later if storage matters.
- Crash-recovery semantics. If the first attempt inserts the row but
  then crashes mid-flow, the retry is rejected — at-most-once
  delivery. The blast radius is small (one missed reply, surfaced in
  `/admin` for manual triage) and the alternative (two-phase commit)
  is overkill for this volume.
- Rejecting webhooks with no `email_id`. Resend always sends one per
  their docs; the rare malformed case continues to process (without
  dedup) and emits an `inbound_missing_email_id` observability event so
  we can investigate.

## Schema

New table `wb_inbound_events` (migration `038_inbound_idempotency.sql`):

```sql
CREATE TABLE wb_inbound_events (
  email_id      TEXT PRIMARY KEY,
  source        TEXT NOT NULL DEFAULT 'resend_inbound',
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  subscriber_id UUID NULL,
  outcome       TEXT NOT NULL CHECK (outcome IN (
                  'reserved',           -- inserted at entry, not yet finalized
                  'processed',          -- fully handled (success or known-terminal skip)
                  'no_subscriber_id',   -- to-address has no reply+ tag
                  'subscriber_not_found',
                  'empty_reply_text'
                ))
);

CREATE INDEX idx_wb_inbound_events_received_at ON wb_inbound_events (received_at DESC);
```

**Why a dedicated table, not reuse `wb_events`:**

- Primary-keyed on `email_id` for O(1) point lookup. `wb_events` would
  require a JSON path query into `properties->>'email_id'` — slow
  without a dedicated functional index, and semantically conflated.
- `wb_events` is observability/analytics ("what happened over time").
  `wb_inbound_events` is a commit log of idempotent operations. Two
  different jobs, two different tables.

## Code paths touched

### 1. `app/api/email/inbound/route.ts` — POST handler

Add an idempotency gate immediately after Svix signature verification,
before any DB read or business logic:

```typescript
// After Svix.verify and JSON.parse:
const { emailId, ... } = extractEnvelope(body)

if (!emailId) {
  // Resend should always send email_id. Log it and fall through to
  // normal processing (without dedup) — we can't dedup what we can't
  // identify.
  await logEvent({
    name: 'inbound_missing_email_id',
    properties: { source: 'resend_inbound' },
  })
} else {
  // Reserve idempotency token. If the row already exists, this returns
  // zero rows; we short-circuit with `already_processed`.
  const reserved = await db
    .insert(inboundEvents)
    .values({ emailId, outcome: 'reserved' })
    .onConflictDoNothing()
    .returning({ emailId: inboundEvents.emailId })

  if (reserved.length === 0) {
    return NextResponse.json({
      received: true,
      processed: false,
      reason: 'already_processed',
    })
  }
}

// ... rest of handler unchanged
```

At each existing terminal exit, finalize the row:

```typescript
// Pattern, applied at each return site:
if (emailId) {
  await db
    .update(inboundEvents)
    .set({ outcome: 'no_subscriber_id' /* or 'empty_reply_text' / 'subscriber_not_found' / 'processed' */, subscriberId: subscriberId ?? null })
    .where(eq(inboundEvents.emailId, emailId))
}
return NextResponse.json({ received: true, processed: false, reason: 'no_subscriber_id' })
```

The success path (full classify + reply) finalizes with `outcome: 'processed'`.

### 2. `lib/schema.ts`

Add the Drizzle table definition for `wb_inbound_events`. Export as
`inboundEvents`.

### 3. `src/winback/migrations/038_inbound_idempotency.sql`

The SQL migration above. Human applies via `psql` against Neon dev
before merging the code change (per CLAUDE.md's branch-discipline
checklist for migrations).

### 4. `src/winback/__tests__/inbound-idempotency.test.ts`

The test referenced as "deferred" in [Spec 63 sweep A](63-winback-ai-regression-tests.md#sweep-a--layer-1-gap-fills-mocked-llm):

- **First webhook** with a new `email_id` processes normally:
  one classifier call, one reply update, full success.
- **Retry of a successful webhook** (same `email_id`) → returns 200
  `already_processed`; classifier NOT called; no row mutations.
- **Retry of a webhook for a `no_subscriber_id` reject** (terminal) →
  also returns `already_processed`; we don't reprocess known-terminal
  outcomes.
- **Concurrent retries** (two near-simultaneous inserts, same
  `email_id`): simulate via `Promise.all` of two POST calls with the
  insert mock failing one with a unique-violation. Exactly one wins;
  the other gets `already_processed`.
- **Missing `email_id`** in envelope → falls through to normal
  processing, emits `inbound_missing_email_id` observability event.

All tests mock the DB; no LLM calls.

## Edge cases

| Case | Behaviour |
|---|---|
| First-ever webhook for an `email_id` | INSERT succeeds → `outcome='reserved'`. Finalized to `'processed'` (or terminal-skip reason) at end. |
| Retry of a successful webhook | INSERT conflicts → 0 rows returned → 200 `already_processed`. No DB mutation, no classifier call, no email. |
| Retry of a webhook that crashed mid-flow | Conflict → 200 `already_processed`. Reply is dropped; surfaces in `/admin` for manual triage. Accepted at-most-once tradeoff. |
| Concurrent retries (same `email_id`, parallel requests) | Postgres PK constraint serializes — one INSERT wins, the other gets 0 rows back and short-circuits cleanly. No deadlock; no double-processing. |
| Webhook with no `email_id` field | Dedup skipped, `inbound_missing_email_id` event logged, processing continues. (Rare; Resend always sends one in practice.) |
| `wb_inbound_events` table missing (migration not run before code deploy) | INSERT throws → bubbles as 500. Acceptable failure mode — without the table we can't safely dedup. CLAUDE.md's branch-discipline rule (migrations applied before code merge) prevents this in practice. |
| `email_id` provided but ridiculously long / non-printable | Stored as-is; PRIMARY KEY accepts any TEXT. No special handling. |

## Verification checklist

For the implementation PR (separate branch, opens after this spec PR merges):

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — existing tests + 5 new idempotency tests all pass
- [ ] Migration applied to Neon dev (`psql` via approved pattern from
      CLAUDE.md — `PGPASSWORD=… psql -h … -U … -d … < 038_*.sql`)
- [ ] Drizzle schema export matches the migration column types
- [ ] Manual smoke on dev: re-trigger an inbound reply twice via
      `curl -X POST` with the same JSON body. Second call returns
      `{ processed: false, reason: 'already_processed' }`. No second
      reply email goes out. `wb_inbound_events` has exactly one row.
- [ ] Spot-check `/admin/events` (or whatever surface lists `wb_events`)
      to confirm `inbound_missing_email_id` fires only for the missing-id
      case, not the happy path.

## Rollback

Purely additive: new table, no existing columns touched, no existing
behaviour modified for unique `email_id`s. To roll back:

1. Revert the route handler change (remove the gate).
2. `DROP TABLE wb_inbound_events;` on Neon.

No data migration in either direction.

## Open questions to resolve before code lands

1. **Reserve-and-finalize or insert-once?** Draft uses
   reserve-at-start + finalize-at-end so we can query `outcome` for
   forensics (did this email_id actually finish?). The simpler
   single-INSERT-at-end approach loses the "we reserved but crashed"
   signal. **Recommendation: reserve-and-finalize** — the extra
   `UPDATE` per webhook is cheap and the observability is worth it.
2. **Retention.** Add a 90-day prune cron now, or defer? **Recommendation:
   defer** — `wb_inbound_events` rows are tiny (~200 bytes), and even at
   10K replies/month the table is ~24MB/year. No urgency.
3. **TextID vs UUID for `email_id` primary key?** Resend IDs are
   `em_<base62>`. Storing as TEXT keeps things simple and avoids parsing
   risk. **Recommendation: TEXT** (as drafted).

If you want different answers to any of these, say so before I open the
implementation PR.

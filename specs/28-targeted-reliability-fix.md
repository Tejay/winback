# Spec 28 — Targeted reliability fix (post-Phase D)

**Phase:** Pre-launch hardening (replaces Spec 10 for now)
**Depends on:** Spec 04 (webhook handler), Spec 09 (dunning), Phase D billing
**Estimated time:** ~4 hours

---

## Context

The Stripe webhook handler currently does the churn pipeline inline:

```
verifySignature → check duplicate → extractSignals → classifySubscriber (LLM)
  → insert subscriber row → scheduleExitEmail (Resend) → return 200
```

There is **one real correctness bug** in this flow: if the row insert succeeds
but `scheduleExitEmail` throws, the webhook returns 500, Stripe redelivers,
the next attempt's idempotency check finds the existing row and bails early
on line ~130 of [webhook/route.ts](../app/api/stripe/webhook/route.ts) — the
email never gets sent. The subscriber sits as `pending` forever.

Spec 10 proposed a full DB-backed queue + cron dispatcher to solve this.
That's the right tool **at scale**. Pre-launch with 0 traffic, the right
tool is the targeted fix that closes the actual bug at a fraction of the
surface area.

This spec ships:

1. **Email-level idempotency** at the DB layer (unique index)
2. **Find-or-resend** logic in webhook handlers so a stuck-pending row
   gets its email retried on the next webhook delivery
3. **429-aware retry wrapper** for the classifier + Resend so transient
   rate-limit failures don't escalate into webhook retries

Plus marks Spec 10 superseded with explicit trigger thresholds for when
to revisit and build the full queue.

---

## Goals

| # | Goal | Mechanism |
|---|---|---|
| 1 | A failed email send must not strand a `pending` subscriber row | Webhook retry resends if `wb_emails_sent` has no matching row |
| 2 | At-most-once delivery for `exit` / `dunning` / `win_back` emails | Partial UNIQUE index on `wb_emails_sent (subscriber_id, type)` |
| 3 | Anthropic / Resend 429s do not cause webhook 500s | `callWithRetry` honours `retry-after` (capped at 60s, max 3 retries) |
| 4 | Cost-cheap to retry a webhook | Idempotency check still skips re-classification when row exists |

---

## Non-goals (deferred to Spec 10 if/when triggered)

- Async webhook return via `waitUntil`
- DB-backed queue with cron dispatcher
- Worker route + zombie reaper
- Dashboard "Stuck" view + retry/mark-lost buttons
- Per-row attempts counter, last_error column

---

## Part A — Email-level idempotency (the keystone)

**Migration:** `src/winback/migrations/023_email_idempotency.sql`

```sql
-- Phase E — at-most-once delivery for the auto-send email types.
-- Other types (e.g. founder_handoff) intentionally support multiple sends,
-- so the index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_sent_unique
  ON wb_emails_sent (subscriber_id, type)
  WHERE type IN ('exit', 'dunning', 'win_back');
```

**Effect:** any second `INSERT INTO wb_emails_sent` for the same
`(subscriber_id, type)` raises a unique-constraint violation. The
`sendEmail` / `scheduleExitEmail` callers catch the violation and treat
it as success (the email already went out — the constraint is the proof).

---

## Part B — Find-or-resend in webhook handlers

**File:** [app/api/stripe/webhook/route.ts](../app/api/stripe/webhook/route.ts)

Refactor `processChurn` (and analogously `processPaymentFailed`) so the
existing-row branch checks whether the email actually went out, not just
whether the row exists:

```ts
async function processChurn(event: Stripe.Event) {
  // ... resolve customer + stripeCustomerId as today

  const [existing] = await db
    .select()
    .from(churnedSubscribers)
    .where(and(
      eq(churnedSubscribers.customerId, customer.id),
      eq(churnedSubscribers.stripeCustomerId, stripeCustomerId),
    ))
    .limit(1)

  let subscriber
  let classification

  if (existing) {
    // Phase E — re-cancel within 14 days still triggers the refund check
    await maybeRefundRecentWinBack(existing.id)

    // Did the exit email actually go out last time?
    const [sent] = await db
      .select({ id: emailsSent.id })
      .from(emailsSent)
      .where(and(
        eq(emailsSent.subscriberId, existing.id),
        eq(emailsSent.type, 'exit'),
      ))
      .limit(1)

    if (sent) return  // happy path: row exists + email sent → done

    // Row exists but email didn't go — re-classify (cheap on cache miss; we
    // could also persist the classification on the row, but the LLM call
    // is bounded by callWithRetry and idempotent in effect)
    subscriber = existing
    classification = await classifySubscriber(/* signals */)
  } else {
    // First delivery — full pipeline
    const decryptedToken = decrypt(customer.stripeAccessToken!)
    const signals = await extractSignals(subscription, decryptedToken)
    classification = await classifySubscriber({ ...signals, emailsSent: 0 }, ctx)
    const [newSub] = await db
      .insert(churnedSubscribers)
      .values({ /* … as today */ })
      .returning()
    subscriber = newSub
  }

  if (classification.suppress || !subscriber.email) return

  // Send (or resend) — unique index guards against double delivery if a
  // race somehow gets two webhooks past the existence check.
  await scheduleExitEmail({
    subscriberId: subscriber.id,
    email: subscriber.email,
    classification,
    fromName: /* as today */,
  })
}
```

**Cost note on re-classification:** an LLM round-trip (~$0.003) per
webhook redelivery is cheap. If we want to amortise it, we could persist
the classification result on the subscriber row in a future iteration —
not in scope for this spec.

`processPaymentFailed` gets the analogous treatment for the `dunning`
email type.

---

## Part C — 429-aware retry wrapper

**New file:** `src/winback/lib/retry.ts`

```ts
/**
 * Spec 28 — Retry wrapper for HTTP 429 (Too Many Requests).
 *
 * Honours the `retry-after` header from Anthropic / Resend / Stripe.
 * Caps individual sleeps at 60s and the overall retry count at 3 to
 * stay within Vercel's 300s function timeout. Non-429 errors are
 * thrown immediately (the caller's existing try/catch handles them).
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; ctx: string } = { ctx: 'unknown' },
): Promise<T> {
  const { maxRetries = 3, ctx } = opts
  let lastErr: unknown
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = (err as { status?: number })?.status
      const headers = (err as { headers?: Record<string, string> })?.headers
      if (status === 429) {
        const retryAfterSecs = Number(headers?.['retry-after'] ?? '5')
        const waitMs = Math.min(60_000, Math.max(1_000, retryAfterSecs * 1000))
        console.warn(`[retry:${ctx}] 429 (attempt ${i + 1}/${maxRetries + 1}) sleeping ${waitMs}ms`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      throw err  // non-429 → bubble up to caller's existing handling
    }
  }
  throw lastErr ?? new Error(`[retry:${ctx}] exhausted ${maxRetries} retries`)
}
```

**Wire it in:**

- `src/winback/lib/classifier.ts` — wrap the `client.messages.create(...)` call
- `src/winback/lib/email.ts` — wrap each `resend.emails.send(...)` call

Both modules already throw on errors today; the wrapper sits inside the
existing `try` and converts 429s into bounded waits + retries instead of
immediate throws.

---

## Part D — Catch the unique-constraint violation in `sendEmail`

**File:** `src/winback/lib/email.ts`

Currently the email send writes `wb_emails_sent` after a successful Resend
call. Under the new index, a webhook redelivery that gets past the
existence check (race) would raise a Postgres unique-violation error
(`code: '23505'`). Catch it and treat as success:

```ts
try {
  await db.insert(emailsSent).values({ subscriberId, type, ... })
} catch (err) {
  const code = (err as { code?: string })?.code
  if (code === '23505') {
    console.log(`[sendEmail] duplicate (subscriber_id, type) — already sent, treating as success`)
    return { messageId: '' }  // already-sent semantics
  }
  throw err
}
```

This is the safety net behind the find-or-resend logic in Part B. Even
if two webhooks race past the existence check, the DB index ensures
exactly one Resend send per `(subscriber, type)` ever.

---

## Part E — Mark Spec 10 superseded with explicit trigger thresholds

**File:** [specs/10-durable-processing.md](10-durable-processing.md)

Add a banner at the top of the spec:

```markdown
> **⚠️ Superseded for now (2026-04-27)** — Spec 28 ships the targeted fixes
> for the actual stuck-pending bug + email idempotency without the full
> queue subsystem. This spec stays as the design we'll build when traffic
> warrants it. **Build it when any of these triggers fire:**
>
> - A real customer's churn email gets lost in production
> - Webhook p95 latency >10s observed in Vercel logs
> - Anthropic 429s appear in `wb_events` more than once per week
> - Volume sustained >1k events/day for a full week
```

This makes the build-or-defer call data-driven for future-you.

---

## Files

**Create:**
- `src/winback/lib/retry.ts` — `callWithRetry` helper
- `src/winback/__tests__/retry.test.ts` — unit tests
- `src/winback/migrations/023_email_idempotency.sql`

**Modify:**
- `app/api/stripe/webhook/route.ts` — find-or-resend in `processChurn` + `processPaymentFailed`
- `src/winback/lib/classifier.ts` — wrap LLM call in `callWithRetry`
- `src/winback/lib/email.ts` — wrap Resend send in `callWithRetry`; catch unique-constraint as success
- `specs/10-durable-processing.md` — supersede banner + trigger thresholds

---

## Verification

### Unit tests
- `retry.test.ts`:
  - 429 with `retry-after` → sleeps the right amount, then retries
  - Non-429 (e.g. 500) → throws immediately, no retry
  - 429 sleep is capped at 60s
  - Exhausting `maxRetries` re-throws the last 429 error
- Update `email.test.ts` to assert the unique-constraint catch branch
  returns gracefully rather than throwing
- Update `webhook` integration tests (where they exist) for the
  find-or-resend branch

### Migration
- Apply `023_email_idempotency.sql` to Neon
- Verify via `\d wb_emails_sent` that the partial unique index is
  present and scoped to the auto-send types

### Manual end-to-end (Stripe test mode)
1. Trigger a churn webhook → email sends, row inserted
2. Replay the same webhook from the Stripe CLI → second attempt sees
   the existing row + the `exit` email, returns early
3. Force `scheduleExitEmail` to throw once (env hack), trigger the
   webhook → first attempt 500s → Stripe redelivers → second attempt
   re-runs classification + retries the send → email arrives
4. Inject a 429 from Anthropic (mock or real Tier 2 burst) →
   `callWithRetry` waits + retries → classification eventually
   succeeds → webhook returns 200 within timeout

### Code health
- `npx tsc --noEmit` clean
- `npx vitest run` — all tests green (target ~290+ after the new
  retry tests)

---

## Trigger thresholds for revisiting (building Spec 10)

Build the full DB-backed queue when *any one* of these is observed:

- 🚨 A real customer's churn email is lost in production (one is enough)
- 📈 Webhook p95 latency >10s in production for a sustained day
- 🔁 Anthropic 429s appear in `wb_events` more than once per week
- 📊 Volume sustained >1k events/day for a full week

Until any of those: this spec is sufficient.

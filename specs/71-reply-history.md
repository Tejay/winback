# Spec 71 — Subscriber reply history + thread-aware classifier

## Context

Today's inbound webhook overwrites `wb_churned_subscribers.reply_text`
on every reply, so the body of every reply but the latest is lost
forever. The classifier therefore only ever sees one reply at a time.

Pre-launch we have no compat baggage — this spec lands a clean
append-only reply table, drops the dead column, and switches the
classifier to read a full chronological thread assembled server-side
from canonical data (outbound emails + stored replies). Belt-and-
suspenders DoS protection caps reply-body size and thread length.

## Goals

1. **`wb_subscriber_replies` table** — append-only, one row per inbound
   reply with body, sender, timestamp, Resend inbound email_id,
   nullable `in_reply_to_email_id` pointing at the matched outbound.
2. **Inbound webhook** writes a new row per reply (no overwrite).
   Caps reply body at **20 KB**, truncating with a `…[truncated]`
   marker. Reads RFC822 `In-Reply-To` header from Resend's payload and
   matches it to `wb_emails_sent.gmail_message_id` to thread the
   reply to a specific outbound (NULL if no match).
3. **`wb_churned_subscribers.reply_text` dropped.** No backward-compat
   shim. All callers either build the conversation thread (classifier)
   or read the latest reply from `wb_subscriber_replies` (a small
   helper `getLatestReply()` for displays that need just one).
4. **`buildConversationThread(subscriberId)`** — single helper that
   returns a chronological list of "we sent" and "subscriber replied"
   turns assembled from `wb_emails_sent` and `wb_subscriber_replies`.
   Capped at the **most-recent 10 turns**; each turn body truncated
   to ~3 KB to keep total prompt under ~30 KB.
5. **Classifier prompt** carries the thread as a labeled block. The
   classifier sees the full back-and-forth, not just the latest reply.
6. **Inspector timeline** renders reply bodies inline next to their
   threaded outbound. Floats reply rows that didn't thread as
   standalone "reply (unthreaded)" items with an icon.

## Non-goals

- Inbound payload search (#8 from the audit — separate spec).
- Signature stripping. Different clients format too inconsistently;
  the LLM can ignore boilerplate. Kept simple.
- Attachment parsing. We already only read `json.text` from Resend's
  `/emails/receiving/{id}` endpoint; attachments are never fetched.
  Spec calls this out explicitly so future contributors don't add it.
- Live re-classify of historical subscribers. Replies that came in
  before this spec are lost; we don't retroactively populate the new
  table. Inspector will show "(pre-migration — body not preserved)"
  for the legacy `reply_text` if needed during the migration window
  (but actually we just drop the column, so historical replies
  simply disappear from the UI — pre-launch this is fine).

## Schema

### New table

```sql
CREATE TABLE wb_subscriber_replies (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id         UUID NOT NULL REFERENCES wb_churned_subscribers(id) ON DELETE CASCADE,
  body                  TEXT NOT NULL CHECK (length(body) <= 20480),
  from_email            TEXT,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Resend's inbound email_id (unique per inbound). Spec 64 already
  -- dedupes at the wb_inbound_events level, but a UNIQUE here is a
  -- second line of defense against double-insert.
  resend_email_id       TEXT UNIQUE,
  -- The outbound email this reply was a response to. Resolved via
  -- the RFC822 In-Reply-To header when the inbound payload carries
  -- one matching a known wb_emails_sent.gmail_message_id. NULL when
  -- no match (subscriber started a fresh email, or the client
  -- stripped threading headers).
  in_reply_to_email_id  UUID REFERENCES wb_emails_sent(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wb_subscriber_replies_subscriber_received
  ON wb_subscriber_replies (subscriber_id, received_at DESC);
```

### Column drop

```sql
ALTER TABLE wb_churned_subscribers DROP COLUMN reply_text;
```

(Pre-launch; data loss is intentional and minimal — dev rows only.)

## Code paths touched

### Migration

**`src/winback/migrations/041_subscriber_replies.sql`** — both the
CREATE TABLE and the DROP COLUMN above. Applied to dev only (no prod
data to migrate yet).

### Schema + types

**`lib/schema.ts`** — add `subscriberReplies` export; remove
`replyText` from `churnedSubscribers`.

**`src/winback/lib/types.ts`** — replace `replyText?: string | null`
in `SubscriberSignals` with `conversationThread?: ConversationTurn[]`.
`ConversationTurn` is `{ kind: 'outbound' | 'reply'; at: Date;
emailType?: string; subject?: string; body: string }`.

### Inbound webhook

**`app/api/email/inbound/route.ts`** — significant rewrite of the
post-body-fetch path:

1. Cap body to 20 KB (`body = body.slice(0, MAX) + '\n…[truncated]'`).
2. Extract the `In-Reply-To` header from Resend's payload (currently
   the body-fetch path returns `{ text, html }`; we extend it to also
   surface `inReplyTo` from the receiving-email response's headers).
3. Try to find a matching `wb_emails_sent` row by
   `gmail_message_id = <stripped in_reply_to>` and same `subscriber_id`.
4. INSERT into `wb_subscriber_replies`. Use the Resend inbound
   `email_id` as `resend_email_id` to dedup at the table level.
5. Set `replied_at` ONLY on the matched outbound row (or skip if
   unmatched — caller can derive from `wb_subscriber_replies` instead).
6. Drop the `subscribers.reply_text` update entirely.
7. Continue with re-classify, but pass a freshly-built thread (see
   below) instead of a single `replyText` string.

### Conversation thread builder

**New: `src/winback/lib/conversation.ts`** — exports
`buildConversationThread(subscriberId): Promise<ConversationTurn[]>`:

1. Pull all `wb_emails_sent` rows for the subscriber, ascending by
   `sent_at`.
2. Pull all `wb_subscriber_replies` rows for the subscriber, ascending
   by `received_at`.
3. Merge into one chronological array; tag each as `outbound` /
   `reply`.
4. Truncate to the most-recent 10 turns (drop oldest first).
5. Truncate each turn's body to 3072 chars (LLM doesn't need full
   prose to grasp intent; this caps prompt size at ~30 KB even with
   10 max-length turns).

**Also exports `getLatestReply(subscriberId): Promise<string | null>`**
for the few callers that just want the most recent reply text (e.g.
the email-rendering code that uses it for personalisation).

### Classifier

**`src/winback/lib/classifier.ts`** — replace the single
`- reply_text: ${signals.replyText ?? 'not_provided'}` line with a
rendered conversation block:

```
CONVERSATION SO FAR (chronological, newest last):
[Day 0] WE SENT (exit) — subject: "We're sorry to see you go"
  body: We just shipped X, would love to hear what would have made you stay…
[Day 3] SUBSCRIBER REPLIED:
  thanks but it's too expensive right now
[Day 5] WE SENT (followup) — subject: "About pricing"
  body: …
[Day 7] SUBSCRIBER REPLIED:
  honestly not really, we moved to Foo Corp
```

When `conversationThread` is empty/absent (first-pass classification
at cancel time), the block is omitted.

### Callers that previously read `sub.replyText`

Every callsite that built signals with `replyText: sub.replyText`
switches to `conversationThread: await buildConversationThread(sub.id)`:

- `src/winback/lib/reengagement-cron-v2.ts:154` (inside
  `processSubscriberForReengagement`)
- `src/winback/lib/email.ts:317` (sendReplyEmail builds signals)
- `app/api/admin/subscribers/[id]/re-classify/route.ts:109` (admin
  re-classify diff)
- `app/api/email/inbound/route.ts` (re-classify after inbound)

### Inspector

**`lib/admin/inspector-queries.ts`** — add a `subscriberReplies` array
to the payload. Inspector client merges it into the existing timeline.

**`app/admin/subscribers/[id]/inspector-client.tsx`** — remove the
`replyText` field from the `Subscriber` interface and the "(latest
reply text shown in Signals)" copy. Render reply bodies inline next
to their threaded outbound. Floats unthreaded replies as standalone
items.

**`app/dashboard/dashboard-client.tsx`** — remove `replyText` field
from the row interface (merchant dashboard doesn't show reply bodies;
the field was unused on this surface but typed in).

### Test winback-flow

**`app/api/test/winback-flow/route.ts` + `app/test/winback-flow/page.tsx`**
— update the `reply` action: instead of writing to `subscribers.reply_text`,
insert into `wb_subscriber_replies`. The action's `replyText` parameter
name stays the same since it's the input string from the test form.

## Edge cases

- **Subscriber replies but webhook is processed twice** — `resend_email_id`
  UNIQUE constraint rejects the second insert. Combined with Spec 64's
  `wb_inbound_events` idempotency token, this is the second layer.
- **In-Reply-To matches a different subscriber's email** — filter the
  match by `subscriber_id` too. The threaded `wb_emails_sent` row
  must belong to the SAME subscriber as the inbound reply.
- **In-Reply-To matches multiple emails (unlikely but possible after
  re-sends)** — take the most recent.
- **Reply body is empty after trimming** — keep the existing
  `'empty_reply_text'` outcome; don't insert a `wb_subscriber_replies`
  row.
- **Reply body is 50 MB** — Resend's `/emails/receiving/{id}` typically
  returns reasonable-size text; we cap at 20 KB defensively. The
  Postgres CHECK constraint enforces the cap at write-time.
- **Classifier prompt overrun** — the 10-turn / 3 KB-per-turn budget
  is the defense. If a future bug pushed past that, Anthropic's API
  would just refuse the call and the classifier would log + propagate
  the error to the cron's per-subscriber error bucket.
- **Unthreaded replies in inspector** — render as standalone items
  with a small `⚠ thread unknown` icon. Most-recent-outbound fallback
  attribution was considered and rejected (silently wrong is worse
  than visibly unknown).

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — add tests:
  1. `buildConversationThread` returns chronological list, caps at 10
     turns, truncates bodies > 3 KB
  2. Inbound webhook inserts a `wb_subscriber_replies` row with the
     20 KB cap applied
  3. Inbound webhook resolves `in_reply_to_email_id` via In-Reply-To
     header when one matches a known outbound
  4. Inbound webhook leaves `in_reply_to_email_id` NULL when header
     is absent / no match
  5. Inbound webhook double-fire on the same `resend_email_id` doesn't
     create duplicate rows (UNIQUE constraint)
  6. Classifier prompt renders the conversation block when thread is
     non-empty; omits the block when empty
- [ ] Manual smoke on dev:
  - Apply migration 041
  - Trigger an inbound reply via `scripts/smoke-inbound-reengagement.ts`
    (existing) — confirm a row appears in `wb_subscriber_replies`
  - Run the test winback-flow's reply action; confirm the new row
    is the canonical source (no `reply_text` column to overwrite)
  - Open inspector → reply body shows inline in timeline
- [ ] Apply migration to dev Neon (no prod yet)

## Rollback

Migration is one CREATE TABLE + one DROP COLUMN. If we need to roll
back:
1. Revert the code PR.
2. Re-add `reply_text` column. (Data is gone from production-data
   perspective; pre-launch this doesn't matter.)
3. Drop the new table.

Each step is independent; no schema-state-machine concerns.

## Phasing

One PR. Estimated ~600 LOC including migration + tests.

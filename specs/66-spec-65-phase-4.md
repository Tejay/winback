# Spec 66 — Spec 65 Phase 4: re-engagement observability + inbound silence

## Context

Spec 65 Phase 3 (PR #102, merged `188fc1d` on 2026-05-13) shipped the V2
re-engagement cron, the V1 cleanup and migration 040. The spec
explicitly deferred a Phase 4 covering two things:

1. **Admin observability** — surface the new V2 cron's matching /
   sanity-check decisions so we can tune the 0.7 `MATCH_CONFIDENCE_THRESHOLD`
   and spot false-positives (e.g. the scenario where a backfilled blob
   was confidently but wrongly matched, and only the sanity check
   caught it).
2. **Reply-to-reengagement behaviour change** — when a subscriber
   replies to a re-engagement email, the current inbound webhook
   classifies AND auto-replies. Spec 65 §"Reply handling" requires:
   re-classify silently, no auto-reply, no founder notification beyond
   the existing inbox flow, no cooldown reset.

Without #1, the threshold and prompt are flying blind. Without #2, a
"thanks but no" reply triggers a chatty AI follow-up that undercuts the
"one shot per improvement" design.

## Goals

- Add `/admin/reengagement` page that lists recent V2 events with the
  fields needed to evaluate matcher quality: subscriber, triggerNeed,
  matched improvement, confidence, sanity-check verdict, drafted email
  preview, whether subscriber replied + sentiment.
- Change `app/api/email/inbound/route.ts` so that when the inbound
  reply is in response to an email of `type='reengagement'`:
  - Re-classify (writes `trigger_need`, `trigger_need_confidence`)
  - Persist the reply text on `wb_churned_subscribers.reply_text`
  - Set `replied_at` on the matching `wb_emails_sent` row
  - **Skip** the auto-reply branch
  - Still notify the founder if subscriber is handed off or paused
    (preserves existing escalation path; the only change is "no auto-AI
    reply", not "no founder notification")
- Log a structured `reengagement_reply` event so the admin page can
  surface "subscriber replied" against the relevant cron event row.

## Non-goals

- Threshold tuning itself (we'll do that *with* the observability data,
  after Phase 4 is in prod for ≥ 1 week).
- Sentiment classification beyond what the existing
  `classifySubscriber` LLM call already produces (we'll display
  `cancellation_category` + the reply text inline; eyeballing is fine
  for v1 of the admin page).
- Building a "flag for prompt review" workflow per spec 65 §"Admin
  observability" — that's bonus polish; this spec ships the read-only
  view first.
- Pattern-clustering / roadmap-signal panel from spec 65 (separate
  follow-up, gated on real triggerNeed volume).

## Schema

**No new migrations.** All needed fields already exist:
- `wb_emails_sent.type` — already populated with `'reengagement'` by V2
  cron (`reengagement-cron-v2.ts:301`).
- `wb_emails_sent.improvement_id` — populated by V2 cron.
- `wb_events.name = 'email_sent'` with rich payload including
  `triggerNeed`, `improvementTitle`, `draftedSubject`, `draftedBody`,
  `matchConfidence`, `sanityReason` (all wired in Phase 3).
- `wb_events.name = 'email_sanity_check_failed'` — also wired.
- `wb_churned_subscribers.reply_text` — existing.

One new event name: `reengagement_reply` (no schema change; events
table accepts arbitrary `name`).

## Code paths touched

### Inbound webhook silence (smaller change)

**`app/api/email/inbound/route.ts`** — currently the auto-reply path
runs unconditionally when `!isHandedOff && !isPaused`. Add a third
gate: look up the most recent `wb_emails_sent` row for this subscriber
(we already query `emailsSent.repliedAt` updates); if its `type ===
'reengagement'`, branch to a "silent re-classify" path:

- Log `reengagement_reply` event (subscriberId, replyTextLength,
  improvementId from the most recent reengagement email)
- Persist re-classification (same DB write as today)
- Return `{ received: true, processed: true, silent: true,
  reason: 'reply_to_reengagement' }`
- Do not call `sendReplyEmail`
- Do NOT short-circuit the existing handoff/pause notification path —
  if either is active, still notify the founder. The change is
  "no AI auto-reply", not "ignore reply entirely".

The lookup is a single `SELECT type FROM wb_emails_sent WHERE
subscriber_id = ? ORDER BY sent_at DESC LIMIT 1`. If that row's type
is anything other than `'reengagement'`, behaviour is unchanged.

### Admin observability page (larger change)

**New: `app/admin/reengagement/page.tsx`** + **`reengagement-client.tsx`**

Server page does the DB read; client renders the table. Pattern matches
existing `app/admin/ai-quality/`.

**Query**: pull `wb_events` rows in the last 30 days where
`name IN ('email_sent', 'email_sanity_check_failed')` AND payload
indicates re-engagement. Join to `wb_churned_subscribers` and
`wb_improvements` for display labels.

**Table columns**:
- Sent-at timestamp
- Subscriber (email + name, link to existing
  `/admin/subscribers/[id]`)
- `triggerNeed` (truncated to 80 chars)
- Matched improvement (title, link to `/reasons` if same merchant)
- Match confidence (0.00–1.00)
- Sanity check (✓ / ✗ with reason on hover; ✗ rows have a red row tint)
- Drafted subject + body (expandable)
- Reply received? (✓ if `wb_emails_sent.replied_at IS NOT NULL` on the
  source email, with badge "neg" / "neut" / "pos" — derived from
  re-classified `cancellation_category` change; for v1, just show ✓
  with reply text on expand)

**Filters** (all client-side, applied to the 30-day window):
- Confidence range slider (default 0.70–0.80 to surface borderlines)
- Only sanity-failed
- Only replied

**Auth**: requires admin (existing `userIsAdmin` helper +
`/admin/layout.tsx`). No merchant access.

### Nav link

**`components/top-nav.tsx`** — already conditionally renders an
"Admin" link for admins. The admin layout side-nav (or wherever the
existing admin sections live) gets a new "Re-engagement" entry pointing
at `/admin/reengagement`.

## Edge cases

- **Subscriber replies multiple times to the same re-engagement
  email**: each reply hits inbound webhook. Each is idempotency-gated
  by Spec 64 (`wb_inbound_events.email_id`). The re-classify is
  per-reply, the latest one wins. Admin page shows the row once with
  the latest reply.
- **Subscriber replies AFTER manual handoff was triggered**: handoff
  takes precedence — founder notification fires, no auto-reply, no
  silent silence (because the handoff branch handles it already). The
  new gate only kicks in when neither handoff nor pause is active.
- **`wb_emails_sent` lookup returns no row**: cannot happen in
  practice (we only reach the reply path because there *was* a sent
  email), but defensively the missing-row case should fall through to
  current behaviour, not crash.
- **Admin query is slow**: scope the events query with a
  `created_at > NOW() - INTERVAL '30 days'` index probe and `LIMIT 200`
  for the page. We already index `wb_events(created_at)`. No new
  index needed.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — add 4 new tests:
  1. Inbound webhook: reply to a `type='reengagement'` email skips
     `sendReplyEmail` and still writes `reply_text` + re-classifies.
  2. Inbound webhook: reply to a `type='exit'` email still triggers
     auto-reply (regression guard).
  3. Inbound webhook: reply to a `type='reengagement'` email under
     handoff still notifies founder (handoff path unchanged).
  4. Admin page query returns event rows joined to subscriber +
     improvement (mock-DB integration test).
- [ ] Manual click-through on dev:
  - `/admin/reengagement` loads, table renders with seeded data
  - Filter to "only sanity-failed" shows only red rows
  - Reply via test webhook fixture is reflected on next page load
- [ ] No prod migration (see "Schema").

## Phasing

One PR — the inbound-silence change and the admin page are scoped
small enough that splitting them adds churn without payoff.

## Rollback

- Admin page is read-only — revert the PR removes the route, no data
  effect.
- Inbound webhook gate is a single `if` branch and a single LIMIT-1
  query. Revert restores the previous auto-reply behaviour with no
  data effect on already-replied subscribers.

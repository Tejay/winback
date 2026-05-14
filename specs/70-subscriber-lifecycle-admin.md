# Spec 70 — Subscriber-lifecycle admin tooling

## Context

From the support-readiness audit (Spec 66 / 2026-05-14) category A:
**Subscriber lifecycle**. Four items, three of which still need work:

- **#1 (P1)** — "Why didn't subscriber X get an email?" V2 cron has
  per-subscriber skip logic (low confidence, no match, cooldown,
  expired, paused, sanity-failed, no improvements) but doesn't log
  per-subscriber events. Inspector can't show the answer.
- **#2 (P2)** — "Why did subscriber X get the wrong email?" No way to
  flag an outbound email for prompt-tuning review.
- **#3 (P2)** — "Mark this subscriber as recovered / lost / pending"
  manually. Auto-attribution is usually right, but support needs a
  manual override (e.g. revive an auto-`lost` row when subscriber
  emails the merchant out of the blue).
- **#4 (P1)** — "Resend a re-engagement email today" — merchant just
  shipped an improvement and wants it pushed now, not at 09:00 UTC
  tomorrow.

Item #5 (clear DNC) deferred — only fires on support mistake, low
frequency, SQL works.

All four touch the subscriber inspector at
`/admin/subscribers/[id]`. Bundling because they share the surface,
auth, audit pattern, and review burden.

## Goals

1. **V2 cron emits `reengagement_skipped` events** per subscriber per
   skip with `{ subscriberId, reason, runDate, ...context }`. Reasons:
   `customer_paused`, `low_confidence`, `no_match`, `sanity_failed`,
   `no_improvements`, `expired` (existing `subscriber_auto_lost` event
   covers expiry, but we'll also flag in skipped for unified
   inspector display).
2. **Inspector "Cron decisions"** section shows the last 20
   `reengagement_skipped` and `reengagement_email_sent` events for
   this subscriber, oldest → newest, with reason + drafted-email
   preview where present. Drives the "why didn't this fire" answer.
3. **"Flag email"** button on every email row in the inspector
   timeline. Click → modal asks for an optional note. POST writes
   `email_flagged` event with `{ subscriberId, emailId, type,
   subject, note, adminId }`. Surfaced on the Admin AI-quality page
   as a follow-up (out of scope here — for now a `wb_events` query
   is enough).
4. **"Force status" dropdown** on the inspector identity header.
   Lets admin pick `pending` / `contacted` / `recovered` / `lost`.
   Mandatory note. POST writes `wb_churned_subscribers.status` and
   emits `admin_action` event with `action: 'subscriber_force_status'`.
   Does NOT touch billing (refund flow stays separate per Spec 67).
5. **"Send re-engagement now"** button on the inspector. POST runs
   the V2 match-and-send pipeline scoped to just this subscriber,
   bypassing the 60-day cooldown but still respecting per-improvement
   uniqueness, sanity check, and customer-pause gates. Audit-logged.

## Non-goals

- Promoting flagged emails into a structured review queue / dashboard.
  Defer; pre-launch volume doesn't justify the build.
- Clearing DNC (#5 — defer).
- Editing classification fields (triggerNeed, tier) directly. The
  re-classify diff exists today and writes nothing; if support wants
  to push the fresh value, that's a separate spec.
- Bulk operations (mark N subscribers, fire re-engagement for N
  subscribers). Per-row only.

## Schema

**No migration.** All new data lands in `wb_events` (existing JSONB
`properties` column) and updates one column (`status`) that already
exists on `wb_churned_subscribers`.

## Code paths touched

### #1 — Skip-reason events from V2 cron

**`src/winback/lib/reengagement-cron-v2.ts`** — extract a small helper
`emitSkipped(reason, sub, extra?)` that calls `logEvent` with name
`reengagement_skipped` + standard properties. Wire it into the 6
existing `stats.skipped*++; continue` branches. Body changes only;
behaviour identical otherwise.

### #1 — Inspector "Cron decisions" section

**`lib/admin/inspector-queries.ts`** — extend `buildInspectorPayload`
to include a new `cronDecisions` array: last 20 events named
`reengagement_skipped` OR `reengagement_email_sent` OR
`email_sanity_check_failed` filtered by `properties.subscriberId`,
sorted DESC by `createdAt`.

**`app/admin/subscribers/[id]/inspector-client.tsx`** — render a new
collapsable section "Cron decisions" between Classification and
Conversation timeline, one row per event with timestamp + reason +
(for email-sent) subject + (for sanity-failed) the sanity reason.

### #2 — Flag email

**New: `app/api/admin/subscribers/[id]/flag-email/route.ts`** — POST
handler with `{ emailId, note? }`. requireAdmin gate. Verifies the
emailId belongs to this subscriber (defends against id injection).
Writes `email_flagged` event with `{ subscriberId, emailId, type,
subject, note, adminId, adminEmail }`.

**Inspector email-row** — add a small "🚩 flag" button visible on
hover next to the subject. Click → tiny inline form (no modal) with
a one-line note input + Submit/Cancel. On success, row badge becomes
"flagged" until page reload.

### #3 — Force status

**New: `app/api/admin/subscribers/[id]/force-status/route.ts`** — POST
handler with `{ status, note }`. Validates `status ∈ {pending,
contacted, recovered, lost}` and `note` is non-empty. requireAdmin.
Updates `wb_churned_subscribers.status` + writes
`admin_action` event with `action: 'subscriber_force_status'`,
`oldStatus`, `newStatus`, `note`.

**Inspector identity header** — replace the static "Status: X" KV row
with a small dropdown + edit button. Dropdown defaults to the
current value. "Save" prompts for the note inline. No-op if status
unchanged.

**Revive on flip-away-from-`lost`**: when admin changes status from
`lost` (or any value where `reengagement_expired_at` is non-null)
to anything else, also clear `reengagement_expired_at` in the same
update. Otherwise the 9-month wall stays armed on the row and the
send-now / cron pipelines keep rejecting it. The endpoint logs
`revived: true` on the audit-log row when this happens.

### #4 — Send re-engagement now

**`src/winback/lib/reengagement-cron-v2.ts`** — extract the
per-subscriber body of the existing for-loop into an exported helper
`processSubscriberForReengagement(sub, opts)` where `opts` carries:
- `bypassCooldown: boolean` (default false — cron uses default; the
  send-now endpoint passes true)
- `runDate?: Date` (default now)

The outer `runReengagementCronV2()` becomes a thin loop calling the
helper.

**New: `app/api/admin/subscribers/[id]/send-reengagement-now/route.ts`**
— POST with no body (just admin gate). Loads the subscriber, calls
`processSubscriberForReengagement(sub, { bypassCooldown: true })`,
returns the outcome (`{ ok: true, outcome: 'emailed' | 'no_match' | …
}`). Writes an `admin_action` event with
`action: 'reengagement_force_sent'`.

**Inspector Actions section** — add "Send re-engagement now" button
next to "Re-run classifier". Modal explains the cost (~$0.006 — match
+ generate + sanity check, three LLM calls), warns it will send a
real email if the matcher fires. Typed confirm: `SEND`.

## Edge cases

- **#1: cron emits skip events even for "boring" reasons** (eligible
  but no match): this is the point — support can answer "why didn't
  the matcher fire?" with `no_match` rather than nothing. Volume of
  events stays modest (max ~1 per eligible subscriber per day, capped
  at BATCH_LIMIT = 50 globally).
- **#2: flagged email's `emailId` doesn't belong to the subscriber**
  in the URL: 400. Cross-customer protection.
- **#3: force-status to `recovered` doesn't trigger billing.** The
  perf-fee path is webhook-driven (subscription event); manual
  status overrides intentionally don't fire it. Documented in the
  endpoint's docstring.
- **#3: status field is what merchants see**. Audit-log every
  override so we can answer "the dashboard says 47 recovered, why?"
- **#4: send-now while subscriber is in customer pause** — pipeline
  still hits the customer-pause gate inside
  `processSubscriberForReengagement`. Returns
  `outcome: 'customer_paused'` and emits the skip event. No real
  email goes out. UI shows the message.
- **#4: send-now bypasses cooldown but per-improvement-once stays**.
  If the only matchable improvement was already emailed to this
  subscriber, the outcome is `no_match` (or "no_improvements" depending
  on how the filter falls). No double-emails.
- **#4: send-now after the 9-month wall.** The expiry sweep doesn't
  run inside the per-subscriber helper, but the eligibility query
  inside the loop did. With send-now we're bypassing the loop, so
  we'd also bypass the wall. Two options:
  a. Allow send-now to override the wall too (admin discretion)
  b. Reject with "subscriber is expired"
  → Go with (b). Expiry means the subscriber has been silent for 9
  months; force-fire risks a creepy "we noticed you cancelled a year
  ago" email. Force-status can revive them first if support really
  wants this.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — add tests:
  1. V2 cron emits `reengagement_skipped` with `reason: 'no_match'`
     when no improvement matches
  2. V2 cron emits with `reason: 'low_confidence'` when classifier
     confidence is low
  3. `POST /flag-email` rejects when emailId doesn't belong to the
     subscriber
  4. `POST /flag-email` writes `email_flagged` event with note
  5. `POST /force-status` rejects invalid status values
  6. `POST /force-status` rejects empty note
  7. `POST /force-status` updates the row + writes audit event
  8. `POST /send-reengagement-now` rejects expired subscriber
  9. `POST /send-reengagement-now` calls the per-subscriber pipeline
     with `bypassCooldown: true`
- [ ] Manual smoke on dev:
  - Reuse `scripts/seed-spec65-v2-test.ts` seed
  - Trigger the cron with one of the scenario subscribers
  - Open inspector → see "Cron decisions" section populated
  - Flag an email → see event in `/admin/events`
  - Change status pending → recovered → audit-log captures it
  - Click "Send re-engagement now" on a fresh scenario → email
    fires (or skip event with reason emitted)
- [ ] No prod migration.

## Rollback

Each piece is additive and independent. Reverting removes UI / new
endpoints but leaves existing data intact. Per-subscriber pipeline
extraction is the only refactor with surface area; the outer cron
function unchanged from a behaviour standpoint.

## Phasing

One PR. Estimated <600 LOC.

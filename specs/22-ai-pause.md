# Spec 22 — Per-subscriber AI pause + dashboard AI status

**Phase:** Next up (April 2026)
**Depends on:** Spec 21 (handoff state, notification helpers), Spec 18 (evidence-based attribution)

---

## Summary

Spec 21 gave us `founder_handoff_snoozed_until` but it's too narrow — only
available on handed-off subscribers, and its name implies "mute notifications"
when founders intuitively expect it to also stop the AI from engaging the
customer.

Two phases:

| Phase | What | Effort |
|------|------|--------|
| 22a | Per-subscriber AI pause — works on any subscriber, pauses AI + notifications | Medium |
| 22b | Derived AI state on the dashboard list view so founders see "who needs me" at a glance | Small |

---

## Context

Founder scenarios not served by today's state machine:

- **VIP / high-value customer** — "I want to handle Sarah personally, don't let the AI auto-email her"
- **Friend / personal relationship** — "Never auto-email Tom"
- **Already handling outside Winback** — "I'm emailing Jane from Gmail, AI shouldn't undercut"
- **Mid-conversation pre-handoff** — "Jane replied once, I'm on it, stop AI from nudging"
- **"Maybe later" reply** — "Pause for 3 months then check in"

All of these need proactive per-subscriber AI pause. Today we can only mute
notifications once handoff has already triggered.

Dashboard gap: `status` (pending/contacted/recovered) doesn't tell a founder
**who needs their attention right now**. They have to click every row to find
out if it's handed off, paused, or AI-active.

---

## Phase 22a — Per-subscriber AI pause

### Schema (migration 014)

```sql
-- Rename preserves existing snooze values — handed-off snoozes keep working
ALTER TABLE wb_churned_subscribers
  RENAME COLUMN founder_handoff_snoozed_until TO ai_paused_until;

-- Track when the pause started (for the 30-day attribution window)
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS ai_paused_at TIMESTAMPTZ;

-- Optional free-text audit: 'handoff', 'founder_handling', 'maybe_later', etc.
ALTER TABLE wb_churned_subscribers
  ADD COLUMN IF NOT EXISTS ai_paused_reason TEXT;

-- Backfill ai_paused_at for existing snoozes (approximate — use updated_at)
UPDATE wb_churned_subscribers
  SET ai_paused_at = updated_at,
      ai_paused_reason = 'handoff'
  WHERE ai_paused_until IS NOT NULL
    AND ai_paused_at IS NULL;
```

### Mental model — two independent gates

An automated email sends only when BOTH gates are clear:

1. **Handoff gate** (existing): `founder_handoff_at IS NULL OR founder_handoff_resolved_at IS NOT NULL`
2. **Pause gate** (new): `ai_paused_until IS NULL OR ai_paused_until < now()`

Keeping them separate is the point. Example: handoff fires → snooze notifications
for 1 day → snooze expires. The pause gate is clear but the handoff gate is
still engaged → AI stays silent. Only notifications resume.

### Semantics

- `ai_paused_until = NULL` → AI free to engage (default)
- `ai_paused_until > now()` → AI silent + founder notifications muted for this sub
- `ai_paused_until < now()` → pause expired; AI free again. Quiet expiry, no reminder.
- Indefinite pause → `ai_paused_until = '9999-12-31'` sentinel

### Reply-during-pause

Same treatment as reply-after-handoff: save the reply, update
`last_engagement_at`, **notify the founder** via the existing
`buildReplyAfterHandoffNotification` helper, don't auto-reply.

```ts
// app/api/email/inbound/route.ts
const isPaused = sub.aiPausedUntil && sub.aiPausedUntil.getTime() > Date.now()
const isHandedOff = sub.founderHandoffAt && !sub.founderHandoffResolvedAt

if (isHandedOff || isPaused) {
  // existing notify-founder branch (already extended for pause)
  return
}
// else: normal auto-reply flow
```

### Changelog-match-during-pause

Match still computes; skip auto-send, notify founder:

```ts
// app/api/changelog/route.ts
if ((sub.founderHandoffAt && !sub.founderHandoffResolvedAt)
    || (sub.aiPausedUntil && sub.aiPausedUntil.getTime() > Date.now())) {
  // existing notify-founder branch
}
```

### Sending paths — add pause filter everywhere

| File | Change |
|------|--------|
| `src/winback/lib/email.ts` | New `isAiPaused(subscriberId)` helper. Guard in `sendEmail()`, `scheduleExitEmail()`, `sendReplyEmail()`, `sendDunningEmail()` — early return if paused. |
| `app/api/cron/reengagement/route.ts` | Both queries (90-day backstop + engaged nudge) add `AND (ai_paused_until IS NULL OR ai_paused_until < now())` |
| `app/api/changelog/route.ts` | Route paused subs to the existing notify-founder branch |

### Handoff also uses the column

When MAX_FOLLOWUPS fires in `sendReplyEmail()`, in addition to setting
`founder_handoff_at`, also set:
- `ai_paused_at = now()`
- `ai_paused_until = '9999-12-31'` (indefinite sentinel)
- `ai_paused_reason = 'handoff'`

Cosmetic (handoff gate already silences the AI) but keeps the data consistent.

Snooze buttons on handed-off subs now set `ai_paused_until = now + N days`,
shortening the indefinite pause. When snooze expires, notifications resume
but handoff gate still blocks the AI.

### API route — unified at `/api/subscribers/[id]/pause`

Replace `/api/subscribers/[id]/handoff/route.ts` with a broader endpoint.

```
POST /api/subscribers/[id]/pause
Body:
  { action: 'pause',  durationDays: number | null, reason?: string }
    // null or missing durationDays → indefinite
  { action: 'resume' }
    // clears ai_paused_until + ai_paused_at + ai_paused_reason
  { action: 'resolve-handoff' }
    // sets founder_handoff_resolved_at = now AND clears pause fields
```

Keep `/handoff` as a thin alias during the transition, delete once UI is updated.

### Dashboard UI

1. **Amber handoff banner** (existing) — unchanged semantics; rename snooze
   buttons to "Pause 1 day / Pause 1 week" for consistency.
2. **Blue pause banner** (new) — shown when `aiPausedUntil > now()` and NOT
   handed off. Shows reason + remaining days + Resume button.
3. **Pause action dropdown** — on any non-paused, non-handed-off, non-terminal
   sub. Durations: 1 day / 1 week / 1 month / Indefinite.

### 30-day strong-attribution window — extends to pause

Spec 21b's handoff attribution window also applies to proactive pause. In
`processRecovery()` and `processPaymentSucceeded()`:

```ts
const HANDOFF_ATTRIBUTION_DAYS = 30

// Handoff window
if (churned.founderHandoffAt) {
  const days = daysBetween(churned.founderHandoffAt, new Date())
  if (days <= HANDOFF_ATTRIBUTION_DAYS) attributionType = 'strong'
}

// Pause window — any proactive pause counts (spec 22)
if (!attributionType && churned.aiPausedAt) {
  const days = daysBetween(churned.aiPausedAt, new Date())
  if (days <= HANDOFF_ATTRIBUTION_DAYS) attributionType = 'strong'
}
```

This rewards Winback for orchestrating the handoff OR surfacing the lead to
the founder for proactive handling. After 30 days, falls back to spec 18
evidence-based rules.

**Resubscribe link click always strong** (spec 18 behavior unchanged).

### Manual resolve clears pause

Unlike spec 21's behavior: when founder clicks "Mark resolved" in the dashboard
for a handed-off subscriber, also clear `ai_paused_until` / `ai_paused_at` /
`ai_paused_reason`. Rationale: resolve means "I'm done thinking about this
one" — keeping the pause sticky causes indefinite notification suppression and
AI-silence on a subscriber the founder explicitly closed out.

If the subscriber is truly gone forever, that's a future "Mark lost" feature.

### Edge cases

| Case | Behavior |
|------|----------|
| Subscriber paused, founder clicks "Mark recovered" | Recovery recorded. Pause becomes moot (status=recovered). |
| Subscriber paused, unsubscribes via link | `doNotContact=true` takes over — stricter than pause. |
| Subscriber paused + customer-wide `pausedAt` | Both independently skip. No conflict. |
| Pause expires mid-cron | Query evaluates at runtime. Handled naturally. |
| Founder pauses indefinitely, never resumes | Sub gets no automation. Expected — founder is in charge. |

### Observability

New `wb_events`:
- `ai_paused` — `{ subscriberId, durationDays, reason }`
- `ai_resumed` — `{ subscriberId }`

Existing `handoff_snoozed` / `handoff_resolved_manually` events continue from
the new endpoint.

---

## Phase 22b — Dashboard AI status

### Derivation

```ts
type AiState = 'active' | 'handoff' | 'paused' | 'recovered' | 'done'

function aiState(sub: Subscriber, now = new Date()): AiState {
  if (sub.status === 'recovered')                                       return 'recovered'
  if (sub.status === 'lost' || sub.status === 'skipped' || sub.doNotContact) return 'done'
  if (sub.founderHandoffAt && !sub.founderHandoffResolvedAt)            return 'handoff'
  if (sub.aiPausedUntil && sub.aiPausedUntil > now)                     return 'paused'
  return 'active'
}
```

### Badges

| AI state | Label | Color |
|----------|-------|-------|
| active | `🤖 AI active` | green |
| handoff | `👋 Needs you` | amber (headline attention) |
| paused | `⏸ Paused · Nd` | blue (shows days remaining) |
| recovered | `✓ Recovered` | green |
| done | `× Lost` / `× Unsubscribed` / `× Skipped` | grey |

### Dashboard changes

1. **Replace Status column** with an AI Status column using `aiState()`.
2. **Replace filter chips**: `All / AI active / Needs you / Paused / Recovered / Done`.
   `Needs you` is the headline filter for the common "what should I do" workflow.
3. **Optional stats bar** above the list:
   `[ 3 need you 👋 ]  [ 5 paused ⏸ ]  [ 12 active 🤖 ]  [ 8 recovered ✓ ]`
   Click a chip → filters the list. Can defer if scope pressure.

### API change

`/api/subscribers/route.ts` — accept new filter values and translate to SQL:

```ts
const validFilters = ['all', 'active', 'handoff', 'paused', 'recovered', 'done']
// build WHERE clause with shared helper from lib/ai-state.ts
```

---

## Files to modify

### 22a

| File | Change |
|------|--------|
| `src/winback/migrations/014_ai_pause.sql` | **New** — rename + two columns + backfill |
| `lib/schema.ts` | Rename `founderHandoffSnoozedUntil` → `aiPausedUntil`, add `aiPausedAt`, `aiPausedReason` |
| `src/winback/lib/email.ts` | `isAiPaused()` helper, guard in 4 send functions, set pause fields on handoff |
| `app/api/cron/reengagement/route.ts` | Pause filter in both queries |
| `app/api/changelog/route.ts` | Route paused subs to notify-founder branch |
| `app/api/email/inbound/route.ts` | Branch on `isPaused \|\| isHandedOff` |
| `app/api/stripe/webhook/route.ts` | Add 30-day pause attribution in `processRecovery()` + `processPaymentSucceeded()` |
| `app/api/subscribers/[id]/pause/route.ts` | **New** — unified pause/resume/resolve endpoint |
| `app/api/subscribers/[id]/handoff/route.ts` | Keep as alias, delete after migration |
| `app/dashboard/dashboard-client.tsx` | Pause dropdown on any sub, new blue pause banner, rename snooze buttons |
| `src/winback/__tests__/ai-pause.test.ts` | **New** — pause gate logic, reply-during-pause, attribution window, resolve clears pause |

### 22b

| File | Change |
|------|--------|
| `lib/ai-state.ts` | **New** — pure `aiState()` + SQL filter helper |
| `components/ai-state-badge.tsx` | **New** — single badge component |
| `app/api/subscribers/route.ts` | Accept new filter values |
| `app/dashboard/dashboard-client.tsx` | Replace Status column + filter chips |
| `src/winback/__tests__/ai-state.test.ts` | **New** — cover all 5 states + combinations |

### Reused utilities

- `resolveFounderNotificationEmail()` in `src/winback/lib/email.ts`
- `buildReplyAfterHandoffNotification()` / `buildChangelogMatchAfterHandoffNotification()` in `src/winback/lib/founder-handoff-email.ts` — work for paused subs unchanged
- `logEvent()` in `src/winback/lib/events.ts`

---

## Verification

### 22a
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` green, new `ai-pause.test.ts` passing
- [ ] Migration 014 applied; existing handoff-snoozed rows still work
- [ ] "Pause AI → 1 week" sets `ai_paused_until` + `ai_paused_at`, logs `ai_paused` event
- [ ] Paused subscriber skipped in both reengagement cron queries
- [ ] Paused subscriber triggers founder notification (not auto-send) on changelog match
- [ ] Reply arrives for paused sub → saved + founder notification + no auto-reply
- [ ] "Resume AI" clears all pause fields; future cron runs include them
- [ ] Handoff snooze 1 day: notifications mute, then resume on expiry; AI stays silent
- [ ] Recovery within 30 days of proactive pause → `strong` attribution
- [ ] Recovery 35 days after pause → evidence-based (likely organic)
- [ ] "Mark resolved" clears both `founder_handoff_resolved_at` and pause fields

### 22b
- [ ] `aiState()` unit tests cover all 5 states + combinations
- [ ] Dashboard renders AI badge on every row
- [ ] Filter chips correctly scope the list
- [ ] "Needs you" count matches handed-off unresolved subs
- [ ] Clicking any row opens the detail panel; existing banners render

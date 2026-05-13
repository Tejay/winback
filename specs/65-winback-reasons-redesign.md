# Spec 65 — Winback Reasons (changelog → re-engagement) redesign

**Status:** draft, awaiting approval.
**Scope:** the merchant-facing "changelog" feature and the re-engagement
pipeline it drives. End-to-end: capture (when subscriber cancels) →
storage (structured improvements) → matching (daily cron) → communication
(re-engagement emails, with cooldown + expiry).
**Out of scope:** promotions / discounts on re-engagement emails (separate
spec, deferred). Payment-recovery / dunning emails (separate flow).

## Context

Today: the merchant has a single textarea (`customers.changelog_text`)
they edit ad-hoc. A daily cron at 09:00 UTC picks up cancelled subscribers
who hit their 90-day post-cancellation mark and compares the *current*
changelog blob against their `triggerNeed`. Match → email. No match →
**still marks `reengagementCount = 1`**, permanently disqualifying the
subscriber from any future re-engagement attempt.

The mechanic is broken in five places at once:

1. **One shot, on a single day per subscriber.** Whatever the changelog
   says on the subscriber's 90-day anniversary is their permanent fate.
   Ship the feature they want 2 days later → silent loss forever.
2. **No structure on the merchant side.** A textarea invites bad inputs:
   typos, vague marketing copy, accidental clears, replacing the whole
   thing for a "weekly update."
3. **No quality gate on the capture side either.** Low-confidence
   `triggerNeed` (silent churn, "personal reasons") feeds into the
   matcher and produces either false-positive emails or wasted LLM calls.
4. **No feedback loop.** Merchant has no idea whether anyone was reached,
   no signal about which cancellation reasons need addressing, no way to
   spot misfires.
5. **No anti-spam ceiling.** The current `reengagementCount < 1` rule
   accidentally also caps to one *attempt*, not one *email* — which
   sounds anti-spam but is actually the source of silent-loss #1.

This spec replaces the system with a structured improvement-entity model,
a two-trigger (publish + cron) eligibility-based matching pipeline,
explicit cooldown + expiry rules, and a redesigned merchant UI that
makes the once-a-month "what did I ship?" interaction feel natural.

## Goals

1. **Cover everyone**: every cancelled subscriber with a confident
   `triggerNeed` should be considered for re-engagement, not just those
   who happen to hit a single magic moment.
2. **Match only when it makes sense**: strict LLM matcher with a
   confidence threshold + a pre-send sanity check. False-negative bias
   is intentional — wrong emails burn trust permanently.
3. **Tolerate sloppy merchant input**: irregular cadence, abstract
   language, accidental deletes — the system degrades gracefully.
4. **Anti-spam is mechanical, not judgmental**: 60-day cooldown +
   per-improvement-once-each cap, both enforced in code. The merchant
   never has to think about it.
5. **Cap merchant exposure to internal mechanism**: dollars, cooldowns,
   email counts, time windows are all internal. The merchant sees
   customer counts and AI-estimated reach. That's it.

## Non-goals

- Promotions/discounts in re-engagement emails (separate spec, later).
- Subscriber-side cancel-form changes — we work with whatever the
  merchant captures via Stripe.
- Multi-language email generation — current single-language behaviour
  carries over.
- Subscriber timezone optimisation — daily cron at 09:00 UTC stays.
- A "draft" state on improvements — single Save = Publish (deliberate
  click). Drafts add a state without enough value.

## Architecture overview

```
                 ┌────────────────────────────┐
                 │ Subscriber cancels         │
                 │ (Stripe webhook)           │
                 └────────────┬───────────────┘
                              │
                              ▼
         ┌──────────────────────────────────────────┐
         │ Classifier (existing, +confidence gate)  │
         │ - extracts triggerNeed + confidence       │
         │ - low-confidence → silent churn          │
         │   (eligible_for_matching = false)        │
         └────────────────────┬─────────────────────┘
                              │
                              ▼
                       ┌─────────────┐
                       │  Eligible?  │
                       └──────┬──────┘
                              │
                ┌─────────────┴─────────────┐
                ▼                           ▼
  ┌──────────────────────┐     ┌─────────────────────────┐
  │ Daily cron (09 UTC)  │◄────│ Merchant publishes      │
  │ - for each eligible  │     │ an improvement (UI)     │
  │ - check active       │     │ - cron picks it up next │
  │   improvements       │     │   run, no immediate     │
  │ - matcher confidence │     │   trigger               │
  │ - sanity check       │     └─────────────────────────┘
  │ - send email         │
  │ - apply cooldown     │
  └──────────────────────┘
```

## Data model changes

### New table — `wb_improvements`

```sql
CREATE TABLE wb_improvements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL REFERENCES wb_customers(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 4 AND 120),
  description   TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  date_shipped  DATE NOT NULL CHECK (date_shipped <= CURRENT_DATE),
  status        TEXT NOT NULL DEFAULT 'published'
                  CHECK (status IN ('published', 'archived')),
  -- Free-text label of the customer-demand pattern this addresses, or null
  -- if the merchant used "Add anyway" (pre-emptive ship with no signal yet).
  addresses_pattern TEXT NULL,
  preempted     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at   TIMESTAMPTZ NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wb_improvements_customer_status
  ON wb_improvements (customer_id, status);
CREATE INDEX idx_wb_improvements_date_shipped
  ON wb_improvements (customer_id, date_shipped DESC);
```

### New table — `wb_improvement_matches`

Tracks which improvement matched which subscriber, used to enforce the
per-improvement-once-each rule.

```sql
CREATE TABLE wb_improvement_matches (
  improvement_id UUID NOT NULL REFERENCES wb_improvements(id) ON DELETE CASCADE,
  subscriber_id  UUID NOT NULL REFERENCES wb_churned_subscribers(id) ON DELETE CASCADE,
  matched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  emailed_at     TIMESTAMPTZ NULL,
  PRIMARY KEY (improvement_id, subscriber_id)
);

CREATE INDEX idx_wb_improvement_matches_subscriber
  ON wb_improvement_matches (subscriber_id);
```

### Changes to `wb_churned_subscribers`

```sql
-- Already has `confidence` (numeric 0-1) from classifier. We add a
-- derived boolean for clarity at the matching layer.
ALTER TABLE wb_churned_subscribers
  ADD COLUMN trigger_need_confidence TEXT
    CHECK (trigger_need_confidence IN ('high', 'low'))
    -- Set during classification: high if confidence >= 0.7 AND triggerNeed
    -- is non-null AND non-empty.
    DEFAULT NULL;

-- Cooldown timestamp — distinct from existing reengagement_sent_at because
-- this one is set by changelog-triggered emails only (the user's earlier
-- clarification that the 60-day cooldown is scoped to this flow).
ALTER TABLE wb_churned_subscribers
  ADD COLUMN last_reengaged_at TIMESTAMPTZ NULL;

-- Hard expiry stamp — when set, the subscriber is marked 'lost' and never
-- considered for matching again.
ALTER TABLE wb_churned_subscribers
  ADD COLUMN reengagement_expired_at TIMESTAMPTZ NULL;
```

### Changes to `wb_emails_sent`

Link re-engagement emails back to the improvement that triggered them.

```sql
ALTER TABLE wb_emails_sent
  ADD COLUMN improvement_id UUID NULL REFERENCES wb_improvements(id) ON DELETE SET NULL;
CREATE INDEX idx_wb_emails_sent_improvement
  ON wb_emails_sent (improvement_id) WHERE improvement_id IS NOT NULL;
```

### Sunset — `customers.changelog_text`

The free-text column is retired. Migration copies its content into a
single `wb_improvements` row (title: "Imported changelog", description:
the existing text) so no merchant-typed content is lost.

## Capture flow

`classifySubscriber` (existing) gains a derived `trigger_need_confidence`
output:

- `high` — `triggerNeed` is non-empty, classifier `confidence >= 0.7`,
  `cancellationCategory` is one of: `Competitor`, `Price`, `Quality`,
  `Unused`, `Feature` (i.e., not `Other`).
- `low` — everything else.

`low`-confidence subscribers are **never** considered by the matcher.
They still receive the exit email; they're just permanently out of the
re-engagement pool.

No new LLM call. The threshold is computed from existing classifier
outputs.

## Improvement entity — UI + API

### CRUD endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/improvements` | GET | List improvements for the merchant (defaults to `status=published`, with `?include=archived` for the archived view) |
| `/api/improvements` | POST | Create. Body validated against the schema (title length, date not in future, description quality gate). Sets `status='published'`. |
| `/api/improvements/[id]` | PATCH | Edit title/description/date/addresses_pattern. Status changes via dedicated endpoint. |
| `/api/improvements/[id]/archive` | POST | Set `status='archived'`, `archived_at = now()`. Requires `{ confirmFeatureRemoved: true, confirmConsequencesUnderstood: true }` in body. |
| `/api/improvements/[id]/restore` | POST | Set `status='published'`, `archived_at = NULL`. |

### Quality gates at POST/PATCH

Server-side, before insert:

1. **Title length** — 4–120 chars (DB check enforces; API returns 400 with
   a clear message).
2. **Description length** — 1–500 chars.
3. **Date shipped** — not in the future.
4. **AI quality classification** — one Anthropic call:
   - **Block** if title/description is junk (`asdf`, `TODO`, placeholder
     text). Return 400.
   - **Warn** if title/description is abstract (no concrete feature
     named). Return 200 with `qualityFlag: 'abstract'`. The merchant
     sees the warning in the UI; the saved entry's `addresses_pattern`
     defaults to "low-match-potential" tag internally — the matcher
     downgrades it.
   - **Pass** otherwise.
5. **Active count cap** — refuse insert if customer already has 10
   `status='published'` improvements. Return 409 with a clear message
   ("Archive one first").
6. **Duplicate detection** — soft; AI checks if the title is
   semantically similar to an existing published improvement. Return
   200 with `duplicateOf: <id>` in the response so the UI can warn but
   not block.

### Lifecycle

- **Published** — counts toward the 10-cap, eligible for matching.
- **Archived** — hidden from active matching, visible under "Show
  archived." Past `wb_improvement_matches` rows remain.
- **No auto-roll-off** — entries stay until merchant removes them. The
  10-cap is the natural pressure to maintain relevance.
- **Soft 12-month prompt** — UI badge on entries with `date_shipped` >
  12 months ago: "Still in product?" with options Yes (resets a
  `confirmed_active_at` timestamp) / Archive / Snooze (3 months).

## Matching pipeline

### Trigger — daily cron only

The existing reengagement cron is rewritten. No publish-time trigger
(simpler, see earlier conversation rationale). When the merchant
publishes, the next cron run picks it up.

### Eligibility query

A subscriber is **eligible** if all of:

- `status` ∈ {`pending`, `contacted`}
- `trigger_need_confidence = 'high'`
- `cancelled_at >= now() - INTERVAL '9 months'` (within the active window)
- `reengagement_expired_at IS NULL`
- `do_not_contact = false`
- `founder_handoff_at IS NULL`
- AI-pause inactive: `ai_paused_until IS NULL OR ai_paused_until < now()`
- Customer not paused for win-back cohort
- Customer not in post-trial billing pause
- Cooldown clear: `last_reengaged_at IS NULL OR last_reengaged_at < now() - INTERVAL '60 days'`

For each eligible subscriber, the matcher runs against all
`status='published'` improvements for their customer.

### Match algorithm

For each `(subscriber, improvement)` pair:

1. **Skip if already-matched** — exists in `wb_improvement_matches` for
   this `(improvement_id, subscriber_id)` pair. Prevents the
   per-improvement-once-each duplicate.

2. **LLM match check** — same prompt as today's
   `matchChangelogToSubscribers`, but returning a structured response:
   `{ matches: boolean, confidence: number, reasoning: string }`.
   Confidence range [0, 1].

3. **Threshold** — only proceed if `confidence >= 0.7`. (Configurable
   constant `MATCH_CONFIDENCE_THRESHOLD`.)

4. **Best-match selection** — across all improvements that pass the
   threshold for this subscriber, pick the single highest-confidence
   one. Discard the rest for this cron pass.

5. **Generate email** — same `generateWinBackEmail` as today, with two
   prompt additions:
   - **Age-aware tone** — pass `monthsSinceShipped` for the matched
     improvement. The prompt instructs: "if older than 3 months, use
     'you may have noticed we shipped X' rather than 'we just shipped
     X.'"
   - **Sanity check pass** — second Anthropic call re-reads the
     `triggerNeed`, matched improvement title+description, and the
     drafted email subject+body, returning
     `{ pass: boolean, reasoning: string }`. If `pass: false`, abort
     send and log `email_sanity_check_failed` event (visible in
     `/admin`).

6. **Send + record:**
   - Insert `wb_emails_sent` row with `type='reengagement'`,
     `improvement_id` set.
   - Insert `wb_improvement_matches` row with `emailed_at = now()`.
   - Update subscriber: `last_reengaged_at = now()`, `status = 'contacted'`.

### What happens to no-match subscribers

**Critically different from today**: the subscriber's
`reengagement_expired_at` is NOT set. They stay eligible. Next cron
run, they'll be checked again against possibly-newer improvements.

### Expiry — the 9-month wall

A separate daily sweep (same cron, second pass) flags expired
subscribers:

```sql
UPDATE wb_churned_subscribers
SET reengagement_expired_at = now(), status = 'lost'
WHERE cancelled_at < now() - INTERVAL '9 months'
  AND reengagement_expired_at IS NULL
  AND status IN ('pending', 'contacted');
```

These subscribers are permanently out of the matching pool. They keep
their match history; no further re-engagement attempts.

## Reply handling

When a subscriber replies to a re-engagement email (existing inbound
webhook path):

1. **Re-classify** — extract a new `triggerNeed` from the reply,
   `OR-merge` with the existing one (LLM judgment of "new info or
   restate?"). Update `wb_churned_subscribers.trigger_need`,
   `trigger_need_confidence`.
2. **Refresh the roadmap signal** — the new `triggerNeed` is in the
   pool for pattern detection.
3. **Do NOT auto-reply** — explicit change from current behaviour. The
   conversation ends after the re-engagement email is sent. Subscriber's
   reply is captured silently for data quality; merchant is notified
   via existing handoff/inbox flow if they want to engage personally.
4. **Cooldown unchanged** — the reply doesn't reset the 60-day
   cooldown. The subscriber stays in cooldown until the timer naturally
   expires.

## Attribution

A subscriber is `recovered` (Winback-attributed) when:

- They re-subscribe AND
- Either:
  - They clicked the reactivation link in a Winback email (tracked via
    UTM param `winback_subscriber_id` on the link, logged at click
    time), OR
  - They re-subscribe within **30 days** of receiving any Winback email
    (exit email OR re-engagement email).

Outside this window: `organic` recovery (not Winback-attributed, no perf
fee).

## Admin observability (Winback-side)

A new section in `/admin` surfaces matcher misfires for prompt-tuning:

- **Recent re-engagement emails** (last 30 days), filterable by:
  - Replied with negative sentiment ("wrong feature", "not what I asked
    for")
  - Sanity check borderline (confidence 0.7–0.8 — closest to threshold)
  - `email_sanity_check_failed` events
- Each row: subscriber's `triggerNeed`, matched improvement, drafted
  email, the reply (if any). Winback admin can flag for prompt review.

Not visible to merchants.

## Merchant UI

The full merchant UI is mocked in
`specs/65-winback-reasons-mockup.html` (committed alongside this spec).
Highlights:

### Page header

- Top nav: "Reasons" (short)
- Page title: "Winback reasons."
- Subtitle: "Real product improvements that go to cancelled customers
  who asked for them. Each improvement stays live until you remove it.
  Max 10 active improvements at a time."

### Roadmap signal panel (top section)

- Surfaces recurring `triggerNeed` patterns across cancellations in the
  last 90 days.
- Threshold: 3+ subscribers + coherent theme.
- Each pattern shows: title + customer count (no `$ at stake`, no names,
  no individual quotes attributed).
- Each has a "+ Add as improvement" button that pre-fills the editor
  with the pattern title and links it via `addresses_pattern`.

### Active improvements list

- Counter: "5 / 10 active improvements."
- "Customers reached" + "Came back" stats strip — counts only, no
  dollars.
- Each row: date shipped, title, description, "matched X · Y came back"
  badge, `⋯` menu on hover (Edit / Archive).
- "Still in product?" prompt on entries > 12 months old.

### Add-improvement form

- Date shipped (required, not future)
- Title (required, 4–120 chars, AI-quality-checked)
- Description (required, 1–500 chars, AI-quality-checked)
- Linked customer reason (multi-select from roadmap patterns, OR "Add
  anyway" override for pre-emptive ships)
- Confirmation checkbox: "I confirm this is real."
- Sidebar — single AI-estimated reach number ("~8–13 customers will
  hear about this over its 12-month life"), plus 2 plain-English
  guardrails.
- Publish button: "Publish improvement →" (no email count, no
  customer names).

### Archive confirmation

- Two checkboxes, both required:
  - "This feature is no longer in the product, OR I shipped it but never
    had customers ask for it, OR I made a mistake adding it."
  - "I understand customers who already heard about this improvement
    cannot be un-told."

### Stale-improvement nudge

- Triggered when last published improvement was >60 days ago AND new
  cancellations exist citing un-addressed patterns.
- Max once per 60 days.
- Cites concrete demand: "12 customers waiting on patterns you haven't
  addressed — top one: Native Slack integration (5 customers)."

## Code paths touched

- New: `src/winback/migrations/039_winback_reasons.sql`
- New: `lib/schema.ts` — `wbImprovements`, `wbImprovementMatches` exports
- New: `app/api/improvements/route.ts` (GET, POST)
- New: `app/api/improvements/[id]/route.ts` (PATCH)
- New: `app/api/improvements/[id]/archive/route.ts` (POST)
- New: `app/api/improvements/[id]/restore/route.ts` (POST)
- New: `app/reasons/page.tsx` — merchant UI shell
- New: `app/reasons/reasons-client.tsx` — interactive editor
- Modified: `components/top-nav.tsx` — add "Reasons" link
- Modified: `app/api/cron/reengagement/route.ts` — entire matching
  pipeline rewritten per this spec
- Modified: `src/winback/lib/classifier.ts` — add
  `trigger_need_confidence` derivation in the existing classifier output
- Modified: `src/winback/lib/changelog-match.ts` — restructured return
  type (`{ matches, confidence, reasoning }`), age-aware prompt,
  pre-send sanity check
- Modified: `app/api/email/inbound/route.ts` — reply-to-reengagement
  path: re-classify silently, no auto-reply (toggle existing logic
  by `type='reengagement'` on the original email)
- Modified: `lib/schema.ts` — `churnedSubscribers` columns
  (`trigger_need_confidence`, `last_reengaged_at`,
  `reengagement_expired_at`); `emailsSent.improvement_id`
- Modified: `customers.changelog_text` retired — used only for migration
  read; new writes blocked
- Modified: `app/admin/...` — new section for matcher misfire review
- New tests under `src/winback/__tests__/`:
  - `improvements-crud.test.ts` — quality gates, cap, archive flow
  - `reengagement-eligibility.test.ts` — new eligibility query, cooldown
    + expiry logic
  - `matcher-confidence-threshold.test.ts` — threshold enforcement,
    best-match selection
  - `matcher-sanity-check.test.ts` — sanity check pass/fail handling
  - `improvement-match-once.test.ts` — per-improvement-once-each
    enforcement
  - `attribution.test.ts` — 30-day window + click attribution

## Edge cases

| Case | Behaviour |
|---|---|
| Merchant publishes 5 improvements in one session | All 5 considered next cron run. Each eligible subscriber matched against best fit (single email). No spam. |
| Merchant edits an existing improvement | No re-trigger for already-matched subscribers. Subscribers not yet matched against it are re-evaluated next cron. |
| Subscriber cancels, replies to exit email with reason | Reply classified (existing flow), updates `triggerNeed`. If now high-confidence, they're now eligible for matching. |
| Subscriber matched, replied to re-engagement email, then re-subscribed within 30 days | Recovery attributed to Winback (within window). Reply re-classifies their `triggerNeed` for future cycles if they cancel again. |
| Improvement archived after it has matched subscribers | Past matches stay. Future cron passes don't consider it. No emails recalled. |
| Improvement quality flagged as `abstract` at write time | Saved with `addresses_pattern = NULL` and `preempted = true`. Matcher downgrades confidence — rarely fires. |
| Subscriber's `triggerNeed` matches multiple improvements | Single highest-confidence match wins. Others wait — but the cooldown will prevent them from firing next cycle, so they effectively never fire (subscriber recovered or moves to `lost`). |
| Subscriber cancels at 13 months citing same reason as an active improvement | They're past the 9-month wall (`reengagement_expired_at` set on next cron sweep). Improvement doesn't reach them. Acceptable — most cancellations cite reasons that have already had a fair chance to be addressed. |
| Anthropic API outage during cron | Cron logs `classifier_failed` events; affected subscribers stay eligible for next run. No data corruption. |
| Migration day: existing `changelog_text` blob | Single `wb_improvements` row created per customer with title "Imported changelog" and the blob as description. Marked `preempted = true`, `date_shipped = customer's earliest known content date`. Merchant prompted to clean up. |

## Verification checklist (for the implementation PR)

- [ ] Migration applies clean on dev + prod Neon
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` clean (~640+ tests after additions)
- [ ] Manual smoke: create 3 improvements, publish, watch a cron run,
      see emails delivered to the test merchant's sandbox subscribers
- [ ] Manual smoke: archive an improvement → confirm it doesn't match
      newly-eligible subscribers next cron
- [ ] Manual smoke: subscriber replies to re-engagement email →
      `triggerNeed` updates, no auto-reply fires
- [ ] Manual smoke: subscriber re-subscribes within 30 days of email
      → `recovered`, attribution=`winback`
- [ ] Re-classification on reply: `trigger_need_confidence` upgrades
      from `low` to `high` when reply provides concrete info
- [ ] Cron logs:
      - `reengagement_email_sent` per successful send (with `improvement_id`)
      - `email_sanity_check_failed` for aborted sends
      - `reengagement_expired` for subscribers hitting the 9-month wall

## Migration path

**Phase 1** (one PR): schema migration + Drizzle types + `wb_improvements` and
`wb_improvement_matches` tables. `customers.changelog_text` column kept,
unread. Migration script seeds one `wb_improvements` row per merchant
with existing content.

**Phase 2** (one PR): new API endpoints + new merchant UI page at
`/reasons`. Top nav updated. Existing `/api/changelog` POST endpoint
deprecated with a 410 response.

**Phase 3** (one PR): rewrite the reengagement cron per this spec.
Originally planned behind a `USE_WINBACK_REASONS_V2` feature flag for
staged rollout. In practice the flag was retired during Phase 3
itself — prod had zero subscribers eligible under the old V1 path
(0 sends in the prior 30 days, 0 changelog content), so staging the
cutover added complexity without buying safety. V1 code path deleted
in the same PR.

**Phase 4** (one PR): admin observability section + reply re-classification
behaviour change (no auto-reply).

Each phase is a separate PR. The schema migration in Phase 1 is
additive (no existing columns dropped, only new tables and new
columns).

## Open questions to resolve before Phase 3

1. **`MATCH_CONFIDENCE_THRESHOLD` value** — proposed 0.7. Tune based on
   admin-observability data once Phase 2 is live and we have signal.
2. **Sanity-check confidence threshold** — proposed: abort if sanity
   check's `pass: false` OR confidence < 0.6. Same tuning approach.
3. **Pattern detection algorithm** — for the roadmap signal, what
   defines a "pattern"? Proposed: LLM-clustered `triggerNeed`s where
   cluster size ≥ 3 AND the LLM's cluster-coherence confidence ≥ 0.7.
   Run as a daily batch step before the matching cron. Worth a small
   spike to validate cluster quality before locking.

## Rollback

Each phase is independently revertable. Schema changes are additive —
rollback doesn't require dropping columns.

The Phase 3 cron rewrite deleted the legacy V1 code path. If a revert
of Phase 3 is ever needed, the prior version of
`app/api/cron/reengagement/route.ts` (commit before Phase 3 merged) can
be cherry-picked back — it reads only from `customers.changelog_text`,
which we deliberately kept as a sunset column for exactly this reason.

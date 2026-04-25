# Spec 27 — Operational Admin Dashboard (Phase 3)

**Phase:** Once Phases 1–2 are dogfooded for a few weeks
**Depends on:** Spec 25 (Phase 1 admin shell + auth + read-only role), spec 26 (Phase 2 surfaces + observability instrumentation), migrations 018

---

## Summary

Three workstreams that close the loop on **debugging real customer traffic**:

1. **Subscriber Inspector** — full-page timeline at `/admin/subscribers/[id]` that walks the entire funnel for one real subscriber. The harness UX, applied to live data.
2. **Live classifier re-run** — opt-in button on the Inspector that re-runs `classifySubscriber()` against today's prompt with the stored signals, returns a side-by-side diff vs the persisted values. Doesn't write. Costs ~$0.003/click; gated.
3. **Audit Log UI** — readable, filtered view of the `admin_action` events already being emitted from Phases 1–2.

One small migration (019): adds `body_text` to `wb_emails_sent` so the Inspector can render the conversation turn-by-turn.

---

## Context

Phases 1 (spec 25) and 2 (spec 26) shipped the operational admin shell. Three observations from running them:

1. **The dev test harness (`/test/winback-flow`) is the most useful thing we have for understanding the AI funnel** — it shows signals → classification → email → reply → re-classification → outcome end-to-end for one case. The admin dashboard currently shows fragments (the AI judgment block, events stream, recent emails) but never the full story. There's no single place to answer "what actually happened with subscriber X".

2. **The `admin_action` audit trail is being emitted but isn't readable.** Every Phase 1 mutation (pause-customer, force-OAuth-reset, bulk-unsubscribe, GDPR delete) and Phase 2 mutation (billing-retry) writes an `admin_action` event. Today you can grep them on `/admin/events` filtered by name, but the JSON payload is dense and unscoped. SOC 2 prep needs a proper audit-log surface.

3. **We have no way to ask "would the AI make the same decision today?" on a real subscriber.** When prompts change (specs 25's tone work, the AI hand-off judgment, the human-voice upgrade), we have no tool to validate against historical cases beyond the seed harness — which uses synthetic data. A live sandbox catches regressions and validates prompt improvements against real signal patterns.

Outcome: a Subscriber Inspector page (the harness UX, applied to live data), an Audit Log UI, and an opt-in classifier sandbox.

---

## Architecture

No new auth pattern. Reuses Phase 1 substrate (`requireAdmin()`, `getDbReadOnly()`, `lib/admin/*`, `admin_action` audit events).

One new schema migration (019).

---

## 27.1 Subscriber Inspector — headline feature

**Route:** `app/admin/subscribers/[id]/page.tsx` (NEW — full page, distinct from the existing cross-customer search drawer)
**API:** `app/api/admin/subscribers/[id]/route.ts`

A timeline view that walks the entire funnel for one real subscriber, mirroring the harness's single-case readout but populated from already-persisted data.

### Layout (top to bottom)

```
[Subscriber identity — name, email, customer (linked), MRR, plan]
[Status + AI state badges]
─────────────────────────────────
[SIGNALS AT CHURN — collapsible]
  stripe_enum, stripe_comment, tenure_days, mrr_cents,
  ever_upgraded, near_renewal, payment_failures, previous_subs,
  cancelled_at, billing_portal_clicked
─────────────────────────────────
[CLASSIFICATION (latest)]
  Tier · confidence · category · recovery_likelihood · trigger_need
  AI reasoning: "<handoff_reasoning verbatim>"
─────────────────────────────────
[CONVERSATION TIMELINE]
  Day 0  → Exit email sent
            Subject: "Fair call on the CSV cap"
            [Body — click to expand]
  Day 2  ← Subscriber replied
            "Honestly $9 would have worked..."
  Day 2  → Follow-up sent
            Subject: "Re: ..."
            [Body — click to expand]
  Day 4  ← Subscriber replied (second time)
  Day 4  → AI handed off / silently closed / sent another follow-up
─────────────────────────────────
[FINAL OUTCOME]
  status='handoff' · founderHandoffAt: ...
  Founder notification sent to: ops@acme.co
  OR
  status='recovered' · attribution: strong · $X/mo
  OR
  status='lost' · auto-closed silent · reason: budget_exhausted_no_handoff
─────────────────────────────────
[ACTIONS]
  [Re-run classifier (~$0.003)]   [Mark DNC]   [Delete (GDPR)]
```

### Data sources

All already in the DB except the email body. Joining:

- `wb_churned_subscribers` row → identity + signals (snapshotted at insert) + latest classification
- `wb_emails_sent` rows → conversation turns + reply timestamps
- `wb_emails_sent.body_text` (NEW — see migration 019) → email body for each turn
- `wb_churned_subscribers.replyText` → most recent reply (current schema only stores LATEST; earlier replies aren't preserved — limitation noted in the UI)
- `wb_events` filtered by subscriber → outcome events (`founder_handoff_triggered`, `subscriber_recovered`, `subscriber_auto_lost`)

### Limitation: per-turn classification history

Only the LATEST classifier output is persisted on the subscriber row. Earlier-turn outputs (e.g., the tier/reasoning before a reply came in) aren't directly recoverable.

**Phase 3 approach:** live with it. Render the latest classification prominently; for earlier turns, infer from email subject + body content. Add a footnote: "Showing the AI's most recent verdict. Earlier-turn reasoning isn't preserved — see Phase 4 follow-up."

**Phase 4 follow-up (flagged in spec, not built):** add a `wb_classifications` audit table, one row per classification pass, captured at the moment of classification. Bigger change, defer until real usage shows the limitation hurts.

### Drawer relationship

The existing cross-customer search drawer (`/admin/subscribers` row click) stays as the quick-scan UX. Adds a "View full inspector →" link at the bottom that navigates to the new page.

---

## 27.2 Live classifier re-run

**Trigger:** "Re-run classifier" button on the Inspector page
**API:** `POST /api/admin/subscribers/[id]/re-classify`

Reconstructs a `SubscriberSignals` object from the persisted subscriber row, calls `classifySubscriber()` (uses real Anthropic API), returns the new classification **without writing to the DB**. The UI renders a side-by-side diff:

```
                  Stored          Fresh
tier              1               1               ✓
confidence        0.92            0.94            +0.02
category          Feature         Feature         ✓
recovery          high            medium          ⚠ shifted
handoff_reasoning <full text>     <full text>     diff
```

### Cost gating

Per CLAUDE.md, every live Anthropic call needs explicit approval. The API route is gated by:
- `requireAdmin()`
- Confirmation parameter in the request body: `{ confirmCost: 'I understand this costs ~$0.003' }` (exact string match — mirrors the GDPR-delete typed confirmation pattern).

UI shows a confirm dialog before sending.

Logs `admin_action { action: 'classifier_re_run', subscriberId, costEstimate: 0.003 }` so spend is auditable.

### Why this is useful

After every prompt change (specs 25 tone work, hand-off judgment additions, etc.), spot-check a handful of past subscribers to validate the new prompt produces sensible verdicts on real signal patterns. Catches regressions that don't show up in synthetic-data tests.

---

## 27.3 Audit Log UI

**Route:** `app/admin/audit-log/page.tsx`
**API:** `app/api/admin/audit-log/route.ts`

A scoped, decoded view of `admin_action` events in `wb_events`. The data is already there from Phases 1–2 — this is purely a presentation layer.

### Filters

- **Action type** — dropdown populated from a hardcoded list of known `properties.action` values (pause_customer, force_oauth_reset, resolve_open_handoffs, unsubscribe_subscriber, dsr_delete, bulk_unsubscribe, billing_retry, classifier_re_run)
- **Admin user** — dropdown of `is_admin = true` users
- **Customer affected** — email/UUID input (reuses the customer resolver from `/admin/events`)
- **Date range** — last 24h / 7d / 30d / 90d

### Layout

Table with columns: Time, Action, Admin (email), Affected customer, Subject (subscriberId / runId / etc — depends on action), Properties (JSON, expand on click).

Each row colour-coded by action category:
- **Destructive** (dsr_delete, force_oauth_reset) → red
- **State change** (pause_customer, resolve_open_handoffs, unsubscribe_subscriber, bulk_unsubscribe) → amber
- **Operational** (billing_retry, classifier_re_run) → blue

### Retention banner

Top of the page: "Showing audit events from the last 90 days. Older events are still in the database; query directly via psql or extend the date filter."

We don't enforce retention yet, but flagging the policy intent in the UI starts the conversation.

---

## Schema (migration 019)

```sql
ALTER TABLE wb_emails_sent
  ADD COLUMN IF NOT EXISTS body_text text;
```

Backfill: historical rows get NULL. The Inspector renders "(body not preserved — sent before instrumentation)" for those.

Three send sites in `src/winback/lib/email.ts` need to start writing the body:
- `sendEmail` (`type: 'exit'`) — the body is `appendStandardFooter(body, subscriberId, fromName)`
- `sendReplyEmail` (`type: 'followup'`) — same shape
- `sendDunningEmail` (`type: 'dunning'`) — same shape

Persist the **already-footered** body so what we store matches what the subscriber actually received.

---

## File manifest

**New files:**
- `app/admin/subscribers/[id]/page.tsx` + `inspector-client.tsx`
- `app/admin/audit-log/page.tsx` + `audit-log-client.tsx`
- `app/api/admin/subscribers/[id]/route.ts`
- `app/api/admin/subscribers/[id]/re-classify/route.ts`
- `app/api/admin/audit-log/route.ts`
- `lib/admin/inspector-queries.ts` — joins for the timeline view
- `lib/admin/audit-log-queries.ts` — wb_events filter helpers
- `src/winback/migrations/019_email_body.sql`
- `src/winback/__tests__/admin-re-classify.test.ts`
- `src/winback/__tests__/admin-inspector.test.ts`

**Modified files:**
- `lib/schema.ts` — add `bodyText` to `emailsSent` table
- `src/winback/lib/email.ts` — three insert sites persist body
- `app/admin/layout.tsx` — add nav link for `/admin/audit-log`
- `app/admin/subscribers/subscribers-search-client.tsx` — drawer footer adds "View full inspector →" link

---

## Test requirements

- **`inspector-queries.ts`** — assembles timeline correctly when emails + replies + outcome events are interleaved; handles missing-body gracefully
- **`re-classify` route** — rejects without exact-string `confirmCost`; calls `classifySubscriber` with reconstructed signals; does NOT write to DB; emits `admin_action`
- **`audit-log-queries.ts`** — filters by action / admin / customer / date; returns only `admin_action` events
- **Body persistence** — extend existing `email.test.ts` to assert `body_text` is included on insert (one assertion each for sendEmail / sendReplyEmail / sendDunningEmail)

---

## Verification

1. `npx tsc --noEmit` — clean
2. `npx vitest run` — all tests green
3. **Apply migration 019 to Neon** (paused for explicit approval per CLAUDE.md)
4. End-to-end on the running dev server:
   - **Inspector populates from real data**: pick a subscriber from `/admin/subscribers`, click into the new full page, verify identity/signals/classification/timeline render
   - **Body persistence**: trigger an exit email send via the test harness, query `wb_emails_sent.body_text`
   - **Re-run classifier**: on the inspector for a previously-classified subscriber, click "Re-run", confirm cost dialog, verify diff renders, verify no DB write occurred, verify `admin_action` event was logged
   - **Audit log**: visit `/admin/audit-log`, apply filters, verify rows colour-code correctly

---

## Out of scope (deferred to Phase 4+)

- **Pre-send preview / send-pipeline override** — requires queueing Resend sends with a delay and an override window; architectural change to `email.ts`; higher risk
- **Customer impersonation** — needs separate security review and session-forging primitive; Phase 3's Inspector achieves 80% of the same operational value with zero session risk
- **Webhook replay** — requires raw Stripe payload persistence (new table); defer until first real incident asks for it
- **Real-time WebSocket updates** — overengineered for pages checked 2–3× daily
- **Email template editor** — premature without more customer feedback
- **Manage-admins UI** — SQL `UPDATE` works fine for the next ~12 months
- **`wb_classifications` audit table** — would let the Inspector show per-turn historical reasoning instead of just the latest. Defer until Phase 3 dogfooding shows the limitation hurts.

---

## Design decisions

### Why a full page for the Inspector instead of expanding the drawer

Drawer ergonomics top out around ~600px width — fine for quick triage but cramped for a full timeline with email bodies. Full page gets the room without sacrificing the drawer (which keeps its job for in-context lookup from search). One page per concern, both available.

### Why we live with the per-turn classifier history limitation in Phase 3

Adding a `wb_classifications` audit table is real schema work + a backfill question (is partial history better than none?). Phase 3 ships the Inspector immediately by inferring earlier turns from emails + replies. If the limitation actually hurts during dogfooding, Phase 4 adds the audit table — at that point we know exactly what columns matter.

### Why re-classify is a button on the Inspector, not a separate `/admin/sandbox` page

Coupling the live re-run to a specific real subscriber is the highest-value form. A general "paste signals, get a classification" sandbox would be useful but is also a different tool — and it's premature without a real workflow that demands it. The button form mirrors how the harness works (per-subscriber simulate buttons) which we already know is valuable.

### Why audit-log is a dedicated page instead of just a saved filter on `/admin/events`

`admin_action` is a single event name with the meaningful detail buried in a JSONB `properties.action` field. A pure-events filter shows the row but not the structured fields. The audit page parses `properties` and renders columns — readable in 1 second instead of 10.

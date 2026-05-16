# Spec 78 — `/admin/ai-quality` dashboard redesign

## Context

The current `/admin/ai-quality` dashboard (shipped under Spec 26 with later
tweaks) has five blocks:

- A — 30-day paired trend bars: handoffs + auto-lost
- B — 30-day recovery-likelihood histogram
- C — 30-day tier distribution
- D — last 50 handoffs (reasoning audit)
- E — last 50 auto-lost (reasoning audit)

Root-and-branch review surfaced six structural problems:

1. **It shows what the AI did, never whether it was right.** We have
   outcome data (`wb_recoveries`, `wb_churned_subscribers.status`,
   `recoveredAt`, `founderHandoffResolvedAt`) but the dashboard never
   joins predictions to outcomes. The single strongest test of the
   classifier — does `recoveryLikelihood=high` actually recover at a
   higher rate than `low`? — is invisible.

2. **Auto-lost is mis-framed.** Doc and UI describe `subscriber_auto_lost`
   as "silent close, AI gave up without trying." Actually it only fires
   after 1-3 emails AND at least one subscriber reply, when the
   reply-thread budget exhausts without an escalation decision. The
   "silent failure" narrative is wrong.

3. **30-day windows are too coarse for drift.** A prompt regression
   shifts metrics in 2-3 days; current 30-day total bars only show it
   after weeks.

4. **No engagement signals on audit cards.** A no-reply zero-click
   auto-lost is treated the same as a 3-reply portal-clicked auto-lost.
   You have to read all 50 cards to find the 5 that matter.

5. **Multiple high-value DB signals are never surfaced.** `confidence`,
   `cancellationCategory`, `triggerNeedConfidence`,
   `founderHandoffResolvedAt`, reply counts, billing-portal clicks — all
   collected, none on the dashboard.

6. **Chronological sort wastes attention.** Audit cards are
   `ORDER BY createdAt DESC`. Misses don't concentrate in the most
   recent rows — they concentrate in the rows with high MRR,
   engagement, and addressable cancellation categories.

## Goals

Redesign `/admin/ai-quality` around the three questions a supervisor
actually asks weekly:

- **Q1 — Is the AI getting better or worse?** (drift detection)
- **Q2 — Where is it most likely to be wrong?** (smart-ranked audits)
- **Q3 — Are the AI's predictions tracking outcomes?** (calibration)

Each new block must include **inline explanation copy** describing what
it is, what healthy looks like, and what to investigate on red. The
dashboard should be readable cold by someone who has never seen it
before — not a tool that only makes sense after reading external docs.

## Non-goals

- No changes to the classifier prompt, classification schema, or any
  upstream data collection. This spec is read-only aggregation + UI.
- No new event types fired. All signals already exist.
- No prompt-version tagging on classifications (deferred — separate
  follow-up, see Future).
- No A/B framework or replay harness (Spec 78 in the cohort-stats path
  is a different proposal; this spec uses 78 first since it's strictly
  read-only and lower risk).
- No alerting / red-light routing changes. The `/admin` overview
  red-light tile is unchanged. This dashboard remains pull-based.

## The seven blocks

### Block 1 — Did the AI's calls hold up? (calibration)

Joins classifications to outcomes on a **settled cohort**: subscribers
classified ≥30 days ago and ≤90 days ago (long enough for outcomes to
exist, recent enough for the data to be representative). For each row
the outcome is taken from `churnedSubscribers.status` joined with
`wb_recoveries` for the recovery-type detail.

Three tables stacked:

**Table 1.1 — Recovery rate by predicted likelihood**

```
                       n     Recovered  Auto-lost  Lost    Still open
high likelihood        47    28%        8%         12%     52%
medium likelihood      134   14%        22%        31%     33%
low likelihood         287   4%         38%        41%     17%
```

Healthy = monotonic (high > medium > low recovery %). If inverted or
flat → the likelihood label is noise.

**Table 1.2 — Handoff vs. non-handoff conversion**

```
                  n     Recovered  Lift vs. non-handoff
handoff           52    31%        +22pp
non-handoff       416   9%         baseline
```

Healthy = positive lift. If the handoff cohort doesn't beat baseline,
the handoff selection is not earning the founder's time.

**Table 1.3 — Auto-lost reversal (false-negative rate)**

```
auto-lost cohort: 61    of which 2 (3%) later recovered
                                         via re-engagement match or manual reactivation
```

`> 0%` = measurable false negatives. The two cases get listed with
links to the inspector.

**Inline explanation:**
> *This block answers "is the AI right." We look at subscribers
> classified 30-90 days ago and check whether the AI's calls panned
> out. If `high likelihood` cases don't recover more than `low` ones,
> the labels are noise. If handoffs don't recover more than
> non-handoffs, escalation isn't pulling its weight. If any auto-lost
> case later recovered, that's a confirmed false negative — read the
> case.*

### Block 2 — What changed this week? (drift detection)

Last 7 days vs prior 23 days (rolling baseline). Six rows; deltas ≥20%
get a warning icon.

```
                              Last 7d   Prior 23d    Δ        Flag
Classifications / day          4.3       3.1         +39%
Tier-4 share                   8%        5%          +60%     ⚠
Handoff share                  11%       14%         -21%     ⚠
Auto-lost / day                0.4       0.3         +33%
recoveryLikelihood=low share   62%       48%         +29%     ⚠
Median confidence              0.62      0.71        -13%     ⚠
```

**Inline explanation:**
> *Prompt regressions show up here in days. Watch in particular:
> Tier-4 share spiking (suppression bug — silent failure), low
> likelihood share rising (prompt got pessimistic), median confidence
> falling (AI hedging — leading indicator of misclassification).*

### Block 3 — Cancellation category mix (replaces tier distribution)

30-day mix + 7-day shift, by `cancellationCategory`
(`Competitor | Price | Quality | Unused | Feature | Other`):

```
Price        24%   →
Unused       21%   ↓ -2pp
Competitor   18%   ↑ +2pp
Other        18%   →
Feature      11%   ↑ +3pp
Quality       8%   →
```

Rows are display-only. Drill-in (click → filtered case list) is
**deferred** — implementing it requires extending
`/api/admin/subscribers/search` with a `?category=` filter and the
corresponding UI on the subscribers page. That's scope creep for this
spec and lives as a future follow-up. The category mix itself still
surfaces the signal — when "Feature +3pp" lights up, the supervisor
knows what to investigate.

**Inline explanation:**
> *Tier tells us how the AI wrote the email. Category tells us what
> subscribers actually said. A "Feature" or "Quality" spike is
> actionable — those are complaints you can fix. A "Competitor" spike
> tells you which competitor and how often.*

### Block 4 — Auto-lost audit (smart-ranked)

Replaces current Block E. Same data source (`subscriber_auto_lost`
events joined to subscriber, customer, replies) but ranked by
**worth-investigating-ness**:

```
score =
   +3 if mrrCents > 5000
   +2 if reply_count >= 2
   +2 if billingPortalClickedAt IS NOT NULL
   +2 if cancellationCategory IN ('Feature', 'Quality')
   +1 if tenureDays > 90
   -2 if cancellation text matches any of:
        'going out of business', 'deceased', 'switching jobs',
        'company shut down', 'no longer in business', 'closing down'
```

Top 15 cards (vs. 50 chronological). Each card shows:

- Customer (merchant), MRR, plan, tenure
- Cancellation reason (own words) + category
- Reply count + portal-click badge
- **Full** `handoffReasoning` (not 200-char excerpt)
- Conversation thread (collapsible — fetch on expand, not bulk-loaded)
- Link to inspector

**Inline explanation:**
> *Auto-lost only fires after 1-3 emails AND at least one reply, when
> the AI runs out of follow-up budget without escalating. These are
> the cases where the AI engaged in conversation and decided not to
> hand off. Ranked top-to-bottom by miss-likelihood (MRR + engagement
> + addressable category). Read the top 5; if any feel like a missed
> escalation, the prompt is too conservative on the second-reply
> decision.*

### Block 5 — Handoff audit (smart-ranked + founder resolution)

Replaces current Block D. Same ranking. Adds a status column based on
`founderHandoffResolvedAt` and final `status`:

- ✓ Resolved → recovered
- ✗ Resolved → lost / unsubscribed
- ⏳ Open (< 7 days old)
- ⚠ Open ≥ 7 days (founder backlog OR low-value escalation)

Aggregate footer:

```
Last 30d: 23 handoffs · 11 resolved · 8 recovered (35% conversion) ·
          4 open · 1 stale (>7d)
```

**Inline explanation:**
> *Each handoff costs founder inbox attention. The conversion column
> shows whether that attention is earning recoveries. Stale opens
> (>7d) are either founder backlog or the AI escalating things that
> didn't warrant it.*

### Block 6 — Low-confidence classifications

Last 25 classifications where `confidence < 0.4`, ordered by
`createdAt DESC`. Each card shows the cancellation snippet, tier,
likelihood, and confidence — no ranking needed, this is the AI
flagging its own uncertainty.

**Inline explanation:**
> *The classifier returns a self-reported `confidence` from 0 to 1.
> Below 0.4 means the AI itself flagged that it was hedging. These
> are the cases where the prompt is struggling — they concentrate the
> weak spots better than reading random classifications. If 80% of
> low-confidence cases land on the same edge case (e.g. ambiguous
> "wasn't a fit" replies), that's where prompt iteration should
> focus.*

### Block 7 — Re-engagement match rate

Of churned subscribers in the last 90 days with
`triggerNeedConfidence = 'high'` (Spec 65 — eligible for matching):

```
Eligible (last 90d):           187
Matched + emailed:              42  (22%)
Still pending (in window):      31
Expired without match:         114  (61%)
```

**Inline explanation:**
> *The AI extracts a `triggerNeed` ("wants Zapier integration") when
> the cancellation has an addressable feature ask. Re-engagement
> matches these against shipping improvements. A low match rate means
> either (a) AI's needs are too vague to match, or (b) we're not
> shipping improvements that address what subscribers are asking for.
> Drill in to see expired-without-match cases — those are revenue we
> can't recover unless we either ship the feature or improve the
> matcher.*

## Schema / migration

**None.** All signals already exist in the schema. The redesign is
pure aggregation + UI.

## Code paths touched

```
lib/admin/ai-quality-queries.ts                 — rewritten (7 new queries; old 5 removed)
app/api/admin/ai-quality/route.ts               — re-shaped payload
app/admin/ai-quality/page.tsx                   — unchanged
app/admin/ai-quality/ai-quality-client.tsx      — rewritten

docs/admin-ai-quality-dashboard.md              — rewritten end-to-end
```

New query functions in `lib/admin/ai-quality-queries.ts`:

- `calibrationByLikelihood(cohortStartDaysAgo=90, cohortEndDaysAgo=30)`
- `handoffConversion(...same cohort...)`
- `autoLostReversal(...same cohort...)`
- `weekVsBaseline()`
- `cancellationCategoryMix()`
- `rankedAutoLostAudit(limit=15)`
- `rankedHandoffAudit(limit=15)`
- `lowConfidenceClassifications(limit=25)`
- `reengagementMatchRate(days=90)`

Each function is a single read-only Drizzle query (or aggregation
followed by a second join — kept simple, no LATERAL joins, no CTE
gymnastics). All hit existing indexes.

## Cohort window definition (Block 1)

The "settled cohort" is subscribers with `createdAt` between 30 and 90
days ago. Rationale:

- ≥30 days: handoffs that became recoveries average 14-21 days end to
  end; 30 days catches the long tail.
- ≤90 days: keeps the cohort representative of recent prompt behaviour.
  Older than 90 days is "old prompt era" data.

The window is shown in the block header explicitly:
*"Cohort: 287 subscribers classified between Mar 16 – Apr 15"* so the
viewer knows the data isn't real-time.

Why not "all classified ≥30 days ago"? Because including 6-month-old
data dilutes prompt-change signal — a prompt iteration shipped today
wouldn't affect the calibration table for months.

## Smart-ranking algorithm (Blocks 4 + 5)

Implementation: computed in SQL via a `CASE` expression, not in
TypeScript. Why: keeps the limit + ordering at the DB level (Spec 73
pattern). One round-trip, no in-memory sort over the full table.

```sql
SELECT
  ...,
  (
    (CASE WHEN mrr_cents > 5000 THEN 3 ELSE 0 END) +
    (CASE WHEN reply_count >= 2 THEN 2 ELSE 0 END) +
    (CASE WHEN billing_portal_clicked_at IS NOT NULL THEN 2 ELSE 0 END) +
    (CASE WHEN cancellation_category IN ('Feature', 'Quality') THEN 2 ELSE 0 END) +
    (CASE WHEN tenure_days > 90 THEN 1 ELSE 0 END) -
    (CASE WHEN
      lower(coalesce(stripe_comment, '') || ' ' || coalesce(cancellation_reason, ''))
        ~ '(going out of business|deceased|switching jobs|company shut down|no longer in business|closing down)'
      THEN 2 ELSE 0 END)
  ) AS interest_score
FROM ...
ORDER BY interest_score DESC, created_at DESC
LIMIT 15
```

The dead-text regex is intentionally narrow — it only catches
unambiguous "definitely not coming back" signals. Anything fuzzier
stays in the candidate pool.

`reply_count` comes from a subquery on `wb_subscriber_replies` grouped
by `subscriber_id`.

## Inline copy

Each block renders a short "what this is" paragraph in slate-500
italic text, directly under the block title. Not a tooltip — visible
on first load. The wording above is the canonical text and should be
used verbatim in the UI.

A top-of-page "How to read this dashboard" expandable section (closed
by default) gives the supervisor-cadence summary:

> **Weekly cadence (Friday, 15 minutes):**
> 1. Glance at Block 2 (drift) — anything flagged ⚠?
> 2. Glance at Block 1 (calibration) — is it monotonic?
> 3. Spot-read the top 5 of Block 4 (auto-lost) — any misses?
> 4. Spot-read the top 5 of Block 5 (handoffs) — any escalations the
>    founder would have declined?
> 5. Glance at Block 3 (categories) — anything spiking?
> If all four green → done. If anything is off → the prompt is the
> suspect. Check `src/winback/lib/classifier.ts` for recent edits.

## Edge cases

1. **Cohort empty in Block 1.** If `n=0` for any likelihood bucket,
   render *"insufficient data"* rather than `0%`. A monotonic claim
   needs all three buckets populated.

2. **Week-vs-baseline with zero in baseline.** Δ% is undefined when
   prior period is 0. Render the new count with no Δ rather than `∞%`.

3. **Smart-ranking ties.** Tiebreak `interest_score DESC, mrrCents DESC, createdAt DESC`.

4. **Block 4 conversation expansion.** Threads can be >10 turns ×
   3KB. Lazy-fetch from a new endpoint
   `GET /api/admin/subscribers/[id]/thread-summary` (already exists in
   inspector — reuse). No bulk-load on initial dashboard render.

5. **Block 5 stale handoff threshold.** "Stale ≥7d" is hardcoded;
   future spec could let admin tune via env var.

6. **Block 7 expired-without-match drill-in.** Out of scope for this
   spec — the count is displayed but click-through is deferred. A
   follow-up spec can add the case-list view.

7. **Block 3 drill-in.** Deferred to a future spec. Display-only here;
   the drill-in requires `/api/admin/subscribers/search` and the
   subscribers UI to accept a `?category=` filter, which is real
   touch-work outside this spec's surface area.

## Phasing

Per the discussion, all four phases ship under this spec:

- **Phase A** — Blocks 2 (drift), 3 (category mix), 6 (low-confidence).
  All-in-DB; no joins.
- **Phase B** — Blocks 1 (calibration), 7 (re-engagement match rate).
  Joins on existing data; cohort window definition.
- **Phase C** — Blocks 4, 5 (smart-ranked audits with thread expansion).
  Adds the SQL ranking expression and the lazy thread fetch.
- **Phase D** — Doc rewrite (`docs/admin-ai-quality-dashboard.md`),
  removal of old block code, UI copy fixes (the "silent closes" line),
  end-to-end click-through.

Phases ship in a single branch + single PR. Each phase is a separate
commit on the branch so the diff is reviewable in chunks.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green (existing tests must keep passing —
      no current tests cover ai-quality-queries; this spec adds basic
      unit tests for the ranking SQL and the cohort-window math)
- [ ] Dev server running; human walks through `/admin/ai-quality`
      end-to-end
- [ ] Each block renders without console errors on empty-data
      (zero-classifications) case
- [ ] Each block renders on present-data case (seed via dev DB)
- [ ] Inline explanation copy renders verbatim from spec
- [ ] Block 3 rows are display-only (drill-in deferred — confirm no
      orphan Link components or routing logic for category filter)
- [ ] Auto-lost card expansion fetches and renders conversation
      thread; no double-fetch on re-expand
- [ ] Block 1 cohort window string ("classified between Mar 16 –
      Apr 15") shown in header
- [ ] Old blocks (A-E) fully removed from
      `ai-quality-client.tsx`; no orphan imports
- [ ] `docs/admin-ai-quality-dashboard.md` rewritten — no leftover
      "silent close" / "AI gave up" framing
- [ ] PR description references "Spec 78"

## Future improvements (out of scope)

- **Prompt-version tagging** on classifications — would let Block 2's
  "what changed" be precise: "this metric shifted on the day prompt
  v7 shipped." Requires schema addition + persistence at classify
  time.
- **Thresholded alerts** — drift detections (Block 2 ⚠ flags) could
  emit a `red_lights` event for the overview tile rather than waiting
  for someone to look.
- **Per-merchant slice** — current redesign is platform-wide. A
  per-merchant filter would help isolate regressions that affect one
  merchant.
- **Block 7 drill-in** — list of expired-without-match cases so we
  can decide whether to ship features that address them.
- **MRR-weighted rates** — Tier 1 at $200/mo matters more than Tier 3
  at $9/mo. Weighting recovery rates by MRR gives a sharper revenue
  view than count-weighted.
- **Cohort window tuning** — fixed at 30-90d here; could become
  admin-configurable.

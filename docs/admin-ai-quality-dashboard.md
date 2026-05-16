# `/admin/ai-quality` — Classifier Supervision Dashboard

A weekly spot-read tool for catching classifier prompt drift before
merchants notice it. The classifier (Spec 72 producer/consumer) makes
thousands of judgments per week: what tier to assign, whether to
hand off to the founder, whether to follow up on a reply or escalate.
This dashboard surfaces *patterns* in those judgments — so you can
catch bad failure modes before customers complain.

Designed around the **three questions a supervisor actually asks
weekly:**

1. **Is the AI getting better or worse over time?** — drift detection
2. **Where is the AI most likely to be wrong right now?** — smart-ranked
   audits
3. **Are the AI's predictions tracking actual outcomes?** — calibration

The complement to this dashboard:
- **`/admin` overview dead-letter tile + Spec 76 drawer** — surfaces when
  the classifier is *broken* (crashing on rows; technical failure).
- **`/admin/ai-quality`** — surfaces when the classifier is *technically
  succeeding but its judgments shifted* in a way that hurts customer
  outcomes (semantic failure, i.e. drift).

## Where it lives

- **Dev**: http://localhost:3000/admin/ai-quality
- **Prod**: https://winbackflow.co/admin/ai-quality

Source:
- Page: `app/admin/ai-quality/page.tsx` → `app/admin/ai-quality/ai-quality-client.tsx`
- API: `app/api/admin/ai-quality/route.ts`
- Queries: `lib/admin/ai-quality-queries.ts`

All seven blocks load in parallel from one API call (no per-block
fetches; this is a load-once dashboard). Conversation threads under
audit cards are lazy-fetched on expand from the existing inspector
endpoint.

## A note on auto-lost framing

This dashboard previously framed "auto-lost" as the AI silently
abandoning a recoverable customer. That framing was wrong. The
`subscriber_auto_lost` event only fires after:

1. We sent the exit email
2. The subscriber replied at least once
3. The AI re-classified on each reply and chose follow-up over handoff
4. The 3-email reply-thread budget exhausted without the AI deciding
   to escalate

So auto-lost is **end-of-conversation closure**, not pre-email
silent give-up. The corresponding failure mode is "AI engaged in a
reply thread but missed a signal that should have triggered a
handoff" — narrower and less catastrophic than the old framing
suggested, but still worth catching.

## The seven blocks

### Block 1 — "Did the AI's calls hold up?" (calibration)

The heart of the dashboard. Joins classifications to outcomes on a
**settled cohort**: subscribers classified ≥30 and ≤90 days ago. ≥30
days because handoffs that recovered average 14-21 days end to end;
≤90 days because older data is "old prompt era" and dilutes the
signal from recent changes. The cohort window is shown explicitly in
the block header.

Three sub-tables:

**Recovery rate by predicted likelihood.** Should be monotonic:
`high > medium > low`. The block auto-renders a ✓ / ⚠ verdict line.

```
                       n     Recovered  Auto-lost  Lost  Still open
high likelihood        47    28%        8%         12%   52%
medium likelihood     134    14%        22%        31%   33%
low likelihood        287     4%        38%        41%   17%
```

**Handoff vs. non-handoff conversion.** If handoffs don't beat the
baseline by some margin, escalation isn't earning the founder's time.

**Auto-lost reversal.** Any auto-lost case that later recovered =
confirmed false negative. Cases are listed with links so you can read
every one.

If everything looks right here, the AI is doing what it claims to
be doing. If it's not monotonic, the likelihood label is noise.

### Block 2 — "What changed this week?" (drift detection)

Last 7 days vs prior 23 days (rolling baseline). Six metrics; deltas
≥20% in the **bad direction** are flagged ⚠:

| Metric                       | Flag direction        |
|------------------------------|-----------------------|
| Classifications / day        | not flagged (volume)  |
| Tier-4 share                 | flagged ↑ (suppression bug) |
| Handoff share                | flagged ↓ (AI dropping escalations) |
| Auto-lost / day              | flagged ↑             |
| recoveryLikelihood=low share | flagged ↑ (pessimism) |
| Median confidence            | flagged ↓ (hedging — leading indicator) |

A prompt regression shows up here in days, not weeks. Confidence drop
is often the first thing to move — the model hedges before it
outright misclassifies.

### Block 3 — Cancellation category mix

30-day distribution by `cancellationCategory`
(`Competitor | Price | Quality | Unused | Feature | Other`) plus the
7-day shift in percentage points.

Tier tells us how the AI wrote the email. Category tells us **what
subscribers actually said**. A "Feature" or "Quality" spike is
actionable — those are complaints you can fix. A "Competitor" spike
tells you which competitor and how often.

Drill-in to a filtered case list is deferred — see "Future
improvements" below.

### Block 4 — Highest-stakes auto-lost cases

Top 15 `subscriber_auto_lost` cases ranked by **interest score**, not
recency:

```
interest_score =
   +3  MRR > $50
   +2  reply_count >= 2
   +2  billing_portal_clicked_at IS NOT NULL
   +2  cancellation_category IN ('Feature', 'Quality')
   +1  tenure_days > 90
   -2  cancellation/comment matches narrow dead-text patterns
       ('going out of business', 'deceased', 'switching jobs',
        'company shut down', 'no longer in business', 'closing down')
```

Each card shows MRR, tenure, reply count, portal-click badge, the
full AI reasoning, and an expandable conversation thread (lazy
fetched). Reading the top 5 of these concentrates the same insight
that reading 50 chronological cards used to give.

If you find a case here you'd have wanted escalated, the prompt is
too conservative on the second-reply decision.

### Block 5 — Highest-stakes handoffs

Same ranking. Adds a **resolution column** derived from
`founder_handoff_resolved_at` and final status:

| Badge                    | Meaning                                |
|--------------------------|----------------------------------------|
| ✓ recovered              | Resolved → subscriber came back        |
| ✗ resolved · lost        | Resolved → didn't convert / unsubscribed |
| ⏳ open                  | Handed off < 7 days ago, not resolved  |
| ⚠ open ≥7d               | Stale — founder backlog OR AI escalated a low-value case |

Aggregate footer summarises the last 30 days: total / resolved /
recovered / open / stale. If most resolved handoffs are "lost" not
"recovered," the AI is escalating cases that won't convert.

### Block 6 — Where the AI hedged (low-confidence audit)

Last 25 classifications where the classifier-reported `confidence` is
below 0.4. These are the cases **the AI itself flagged it was
hedging on** — they concentrate the prompt's weak spots better than
reading random cases. If 80% of them land on the same edge case
(e.g. ambiguous "wasn't a fit" replies), that's where prompt
iteration should focus.

### Block 7 — Re-engagement match rate

Of subscribers in the last 90 days with `triggerNeedConfidence='high'`
(Spec 65 — eligible for re-engagement matching):

- Matched + emailed (✓)
- Pending (still in window)
- Expired without a match (×)

A low match rate has two distinct causes worth distinguishing:
- **AI's `triggerNeed` text is too vague** — the LLM matcher can't
  decide whether a shipped improvement addresses it. Fix: tune the
  classifier prompt for more specific `triggerNeed` extraction.
- **Merchant isn't shipping improvements that address asks** — the
  asks are clear, we just don't ship things that resolve them. Fix:
  product roadmap conversation, not a prompt change.

## Suggested weekly cadence

Friday afternoon, ~15 minutes:

1. Glance at **Block 2 (drift)** — anything flagged ⚠? Confidence
   drop is the leading indicator; investigate that first.
2. Glance at **Block 1 (calibration)** — is the recovery rate
   monotonic across high / medium / low likelihood? If not, the
   labels are noise.
3. Glance at **Block 3 (category mix)** — anything spiking? A Feature
   or Quality surge is actionable.
4. Spot-read the top 5 of **Block 4 (auto-lost)** — any you'd have
   wanted escalated?
5. Spot-read the top 5 of **Block 5 (handoffs)** — any stale opens?
   Any resolved-and-lost that the AI shouldn't have escalated?
6. Glance at **Block 6 (low-confidence)** — concentrate prompt-iteration
   attention here.
7. Glance at **Block 7 (match rate)** — if expired-without-match is
   high, decide whether it's a prompt issue or a product issue.

If anything looks off → the prompt is the suspect. Check what's been
changing in `src/winback/lib/classifier.ts` and roll back / iterate.

## How this fits with the rest of the classifier infrastructure

| Surface | Catches |
|---|---|
| `/admin` overview Dead-letter tile + drawer (Spec 76) | Classifier *crashing* (technical failure — rows failing 3 times) |
| `/admin/ai-quality` (this dashboard) | Classifier *technically succeeding but judgments shifted* (semantic failure — drift) |
| `/admin/events?name=classifier_failed` | Detailed per-event log for either of the above |
| Spec 72 retry/dead-letter mechanism | Automatic recovery from transient failures (cron retries up to 3 times) |

This is the *supervisory* layer. Without it, prompt regressions would
only get caught by merchants emailing in to complain — which is much
too late.

## Future improvements (out of scope today)

- **Block 3 drill-in** — click a category to see the cases. Requires
  extending `/api/admin/subscribers/search` with a `?category=` filter
  and matching subscribers-page UI.
- **Prompt-version tagging** on classifications — would let Block 2's
  "what changed" be precise: "this metric shifted on the day prompt
  v7 shipped." Requires schema addition + persistence at classify
  time.
- **Thresholded alerts** — drift detections (Block 2 ⚠ flags) could
  emit a `red_lights` event for the overview tile rather than waiting
  for someone to look.
- **Per-merchant slice** — current dashboard is platform-wide. A
  per-merchant filter would help isolate regressions that affect a
  single merchant.
- **Block 7 drill-in** — list of expired-without-match cases so we
  can decide whether to ship features that address them.
- **MRR-weighted rates** — Tier 1 cases at $200/mo matter more than
  Tier 3 cases at $9/mo. Weighting recovery rates by MRR gives a
  sharper revenue view than count-weighted.
- **Cohort window tuning** — fixed at 30-90d here; could become
  admin-configurable.

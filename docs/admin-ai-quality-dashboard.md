# `/admin/ai-quality` — Classifier Supervision Dashboard

A weekly spot-read tool for catching classifier prompt drift before
merchants notice it. The classifier (Spec 72 producer/consumer) makes
~thousands of judgments per week: which subscribers to email, what tier
to assign, whether to hand off to the founder, whether to silently close
a case as unrecoverable. This dashboard surfaces *patterns* in those
judgments — so you can catch the bad failure modes (overly optimistic,
overly pessimistic, suppressing things it shouldn't) before customers
complain.

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

All five blocks below load in parallel from one API call (no per-block
fetches; this is a load-once dashboard).

## The five blocks

### Block A — Paired 30-day trend bars

Two bar charts side-by-side, daily counts over the last 30 days:

- **Hand-offs triggered** (amber bars) — how often the AI decided "this
  needs the founder personally"
- **Subscribers auto-lost** (slate bars) — how often the AI silently
  closed a case as unrecoverable

**Why these two are paired:** the *worst* failure mode is **handoffs
flatlining while auto-lost climbs** — the AI getting more aggressive
about giving up and not escalating high-value cases. By pairing the two
charts, this regression is visible at a glance.

**Other patterns to watch for:**
- Sustained spike in handoffs → prompt regression escalating too eagerly
  (founder fatigue incoming)
- Flatline near zero on both → AI not classifying anything (signal
  something broke upstream; check Spec 76 dead-letter drawer)
- Auto-lost slowly climbing over weeks → prompt drift toward
  pessimism

### Block B — Recovery likelihood histogram

The classifier outputs `high | medium | low` for every classified
subscriber's `recoveryLikelihood` field. Histogram shows the 30-day
distribution.

**Healthy range:** approximately
- ~10–20% high
- ~30–40% medium
- ~40–60% low

**Failure modes:**
- **Majority-high** → model became overly optimistic. "Everyone's
  recoverable!" — they're not. Wastes founder attention.
- **Majority-low** → model gave up on everyone. Usually after a prompt
  change made it pessimistic. Real recoverable customers get auto-lost.

### Block C — Tier distribution

Stacked bar of Tier 1 / 2 / 3 / 4 classifications over the last 30 days.

| Tier | Meaning |
|---|---|
| 1 | Explicit stated reason in stripe_comment or reply thread — most actionable |
| 2 | Stripe enum only (e.g. `too_expensive`), no free text |
| 3 | Silent churn — billing signals only, no reason given |
| 4 | Suppress — no email sent. Used only when subscriber email is null. |

**Failure modes:**
- **Tier-4 surge** = classifier started suppressing things it shouldn't.
  This is the silent-failure mode after a prompt change. Easy to miss
  because affected subscribers simply never get an email.
- **Tier-1 climbing** = more actionable reasons being parsed. Good
  direction, usually means a prompt improvement landed.

### Block D — Handoff audit (last 50 reasonings)

The actual money block. Each card is a real subscriber the AI handed off
to the founder, showing:

- Subscriber name + plan + MRR
- Their cancellation reason (in their own words, where available)
- **The classifier's own justification for the handoff** (the
  `handoffReasoning` field, written by the LLM at classification time)
- Recovery likelihood badge
- Link to the subscriber inspector

**Weekly workflow:** spot-read 10 a week. If you find 3 you'd disagree
with → the prompt needs work. The classifier writes its own reasoning
when it decides to hand off; reading these is the best signal for
"is the AI's judgment aligned with mine?"

### Block E — Auto-lost audit (last 50 silent closes)

The most dangerous category — **false negatives**. These are cases the
AI silently closed without ever escalating, ever sending another email,
or ever giving the merchant a chance to recover the customer.

Each card shows:
- Customer (the merchant) — not the subscriber, since auto-lost is a
  property of "this subscriber was closed under merchant X's account"
- Timestamp
- The AI's reasoning excerpt for why it gave up (`reasoningExcerpt` in
  properties)
- Recovery likelihood badge

**Weekly workflow:** read these looking for *any* you'd have wanted
escalated. If you find one → the prompt is too aggressive about closing
out, and you've just found a real lost-revenue case the merchant didn't
know about.

## Suggested weekly cadence

Friday afternoon, 10 minutes:

1. Glance at Block A — are both bars in their expected range? Is
   handoff/auto-lost moving in opposite directions in a worrying way?
2. Glance at Block B — does the histogram look like the healthy range?
3. Glance at Block C — any tier surging suspiciously?
4. Spot-read 10 cards in Block D. Disagreements counted on fingers.
5. Spot-read 10 cards in Block E. Anything that should have escalated?

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

## Future improvements (when relevant)

Things the dashboard does NOT have today but might earn its keep later:

- **Thresholded alerts** — currently you have to look. If handoffs drop
  to zero, no one tells you. Could fire a `red_lights` entry on the
  overview when one of these metrics crosses a sustained threshold.
- **A/B comparison view** — compare last 30 days vs the previous 30,
  side-by-side, so you can see "did my prompt change move things?"
- **Per-tier MRR-weighted views** — Tier 1 cases at $200/mo matter more
  than Tier 3 cases at $9/mo. Could weight the trends by MRR for a
  sharper revenue-impact lens.
- **Per-prompt-version cohort comparison** — once prompt versions are
  tagged on classification events, slice the metrics by which prompt
  produced them.

None urgent. The dashboard works as-is for spot-reading.

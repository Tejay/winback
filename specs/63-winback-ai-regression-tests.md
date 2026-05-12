# Spec 63 — Winback AI regression test suite

**Status:** draft, awaiting approval.
**Scope:** win-back only — the AI flow that classifies cancellations, sends the
first personalised email, handles replies, hands off to the founder, and fires
re-engagement on changelog matches. **Out of scope:** payment-recovery (dunning)
emails, billing, subscription lifecycle — covered by the Tier 1–6 billing
regression suite already shipped in [PR #88](https://github.com/Tejay/winback/pull/88).

## Context

The win-back AI is the heart of the product — every email that goes out is
LLM-generated, classification is LLM-judged, and handoff decisions are
LLM-judged. We have ~7 vitest files under `src/winback/__tests__/` covering
pieces of this, but no single suite that exercises *the full subscriber-facing
and merchant-facing flow* across the realistic input space. As a result, when
we tweak the classifier prompt or the reply rules, we have no fast way to know
"the AI still says the right thing in every realistic scenario."

This spec is the **reference document for that regression suite.** It lists
every scenario we want green before we ship a new prompt change. The suite
will be built up over several PRs (each "sweep" below = one PR). The spec
stays on `main` as the index — sweeps reference it, not the other way round.

## Goals

1. Catch a classifier-prompt regression that mis-routes a realistic
   cancel-reason fixture, in CI, before merge.
2. Catch a first-email-quality regression (banned phrase, fabricated reason,
   wrong tier opening) in CI, before merge.
3. Catch a reply-handling regression (auto-replies when should handoff, or vice
   versa) in CI, before merge.
4. Give the human a 30-minute manual checklist that fully exercises both the
   **subscriber inbox experience** and the **merchant dashboard experience**
   on dev before each prod release.
5. Make the LLM-call cost of running the full suite ≤ \$1 per PR, gated
   behind `RUN_LLM_TESTS=1` so commits that don't touch AI code don't pay it.

## Non-goals

- Replacing the existing fixture/unit tests — extending, not rebuilding.
- Building a synthetic-traffic load test — this is correctness, not load.
- Testing payment-recovery / dunning / billing — separate suite already exists.
- Testing the Resend webhook signature path or Stripe webhook signature path —
  covered by `email.test.ts` and the billing suite respectively.
- Replacing human review of the classifier prompt itself — the suite verifies
  *behaviour*, not that the prompt text is "good."

## Test architecture — three layers

### Layer 1 — Fixture-driven unit tests (mocked LLM)

Cheap, deterministic, run on every commit. We feed pre-recorded LLM JSON
responses and verify routing, gates, persistence, and idempotency.

### Layer 2 — Real-LLM integration tests (golden inputs, mocked I/O)

Real `anthropic` calls (Claude Haiku 4.5). Stripe/Resend/DB mocked. Gated
behind `RUN_LLM_TESTS=1`. Run on PR. Expected cost per full run: ~\$0.30.

Two judging styles:
- **Structured-field assertions** — assert on the `reasonCategory`,
  `recoveryLikelihood`, `handoff` fields the LLM returns. Exact match.
- **Email-quality judge** — a second Claude Haiku call that scores the
  generated `firstMessage` against a fixed rubric and returns
  `{passed: boolean, failures: string[]}`. Use the judge sparingly (~15 cases),
  not on every fixture.

### Layer 3 — Manual end-to-end on dev (real LLM, real Resend, sandbox Stripe)

Documented checklist, ~30 minutes, run by the human before each prod release.
Walks the full subscriber inbox experience (in a real Gmail) and the full
merchant dashboard experience (clicking through `/admin` and `/dashboard`).

## Sweeps — order of implementation

Each sweep is one PR. The spec is the source of truth — sweeps reference
"Spec 63 sweep A" etc.

### Sweep A — Layer 1 gap-fills (mocked-LLM)

**Goal:** close the holes in our existing fixture coverage.

**Test files to add under `src/winback/__tests__/`:**

- `tier-resolution.test.ts` — table-driven test of the tier-resolution logic.
  For each row in the table `{stripeComment, stripeEnum, replyText, mrrCents,
  tenureDays} → expected tier ∈ {1,2,3,4}`, classify with a mocked LLM that
  returns a tier-tagged response, assert the right tier is recorded on
  `churnedSubscribers.tier` (or equivalent column).
- `gate-matrix.test.ts` — table-driven test of the gate composition. For each
  row in the table `{doNotContact, customerPausedWinback, customerPausedBilling,
  aiPausedUntil, founderHandoffAt, followupsSent} → expected skip_reason ∈
  {sent, dnc, customer_paused, billing_pause, ai_paused, handoff, max_followups}`,
  call `sendEmail()` and assert (a) no Resend call is made when skipped,
  (b) the right `wb_events` row is written.
- `inbound-threading.test.ts` — table-driven test that an inbound Resend
  webhook with `In-Reply-To` / `References` headers resolves to the correct
  `churnedSubscribers` row even when the From-address differs from the
  original to-address (forwarded, alias, +tag).
- `idempotency.test.ts` — for each webhook source (Stripe
  `customer.subscription.deleted`, Resend `email.received`), replay the same
  payload twice and assert exactly one DB row + one outbound email.

**Cost:** 0 (no LLM calls).
**Acceptance:** new tests + all existing vitest still green.

### Sweep B — Layer 2.A: classification golden fixtures

**Goal:** catch classifier-prompt regressions in CI.

**Files:**
- `src/winback/__tests__/fixtures/classifier/{competitor,price,quality,unused,feature,other}/` — ~10 JSON fixtures per category. Each fixture is `{ signals: SubscriberSignals, expected: { reasonCategory, recoveryLikelihood, handoff } }`.
- `src/winback/__tests__/classifier-golden.test.ts` — iterates fixtures, calls real `classifySubscriber()`, asserts exact match on the three expected fields. Gated behind `RUN_LLM_TESTS=1`.

**Fixture sources:**
- Synthetic — drafted from realistic cancel-survey copy seen in the
  competitor space (ChurnZero, Recharge case studies).
- Real, sanitized — any cancellations we've seen on
  `testfounder.winback@gmail.com` or dev. Sanitize before committing.

**Categories and sample inputs (final fixture set drafted in the PR):**

| Category | Sample fixtures (10 each) |
|---|---|
| Competitor | "switching to Stripe Billing", "moving to ChartMogul for retention", "Recharge has native bundles" |
| Price | "$99 is too much right now", "found a cheaper alternative", "can't justify the cost this quarter" |
| Quality | "support ignored my ticket for 2 weeks", "kept crashing on Safari", "broke our Stripe webhook" |
| Unused | "haven't logged in for 3 months", "no longer need this product", "set it up and forgot about it" |
| Feature | "no SSO support", "need outbound webhook for X", "missing Recurly export" |
| Other / silent | empty comment + cancelled within trial; abusive ("you scammed me"); multilingual ("c'est trop cher"); sarcasm ("loved how it never worked"); reason='other' + no comment |

**Cost:** ~60 fixtures × \$0.003 = ~\$0.18 per run.
**Acceptance:** 60/60 fixtures pass with the current production prompt.
Any sweep B fixture that fails on day 1 is either (a) re-categorised after
human review, or (b) a real classifier bug that we fix in the same PR.

### Sweep C — Layer 2.B: first-email quality (judge LLM)

**Goal:** catch first-email regressions (banned phrases, fabricated reason,
wrong tier opening, length blow-out, tone drift).

**Files:**
- `src/winback/__tests__/email-quality-judge.ts` — Claude Haiku judge that
  takes `(signals, firstMessage)` and returns
  `{ passed: boolean, failures: string[] }` against a rubric.
- `src/winback/__tests__/first-email-quality.test.ts` — iterates ~15
  representative fixtures from sweep B (covering each tier × category cell),
  calls real `classifySubscriber()`, passes the `firstMessage` to the judge,
  asserts `passed === true`.

**Rubric (encoded into judge system prompt):**

1. **Tier 1 opener** — opens with validation, references the explicit reason
   from `stripeComment` or `replyText`.
2. **Tier 2 opener** — references the reason category at most generically, no
   fabricated specifics.
3. **Tier 3 opener** — soft opener, no false specificity, asks one open question.
4. **Tier 4** — `firstMessage` is null/absent.
5. **No banned phrases** — exhaustive list maintained in the rubric file:
   "we'd love to have you back", "valued customer", "our records show", "as a
   token of our appreciation", etc.
6. **Body length** — ≤ 120 words.
7. **Subject length** — ≤ 50 characters.
8. **Voice** — first-person singular ("I", not "we" except when referring to
   the company in passing).
9. **No fake urgency** — no "limited time", no "expires in 24 hours".
10. **No fake personalisation** — no `{first_name}` style template leakage.

**Cost:** 15 × (\$0.003 classify + \$0.003 judge) = ~\$0.09 per run.
**Acceptance:** 15/15 pass with current production prompt.

### Sweep D — Layer 2.C: reply-handling matrix

**Goal:** catch regressions in the auto-reply vs. handoff decision.

**Files:**
- `src/winback/__tests__/fixtures/replies/` — fixtures of `{originalSignals, replyText, expected: { action: 'auto-reply' | 'handoff' | 'dnc' | 'stop' | 'recover', handoffReason?: string }}`.
- `src/winback/__tests__/reply-handling.test.ts` — simulates the inbound
  webhook with the reply text, asserts the decision matches expected.

**Scenarios (one fixture each, ~12 total):**

| Reply | Expected action | Reason |
|---|---|---|
| "Can I get 50% off?" | handoff | price negotiation |
| "If you add SSO I'll come back" | auto-reply + log `triggerNeed='SSO'` | actionable trigger |
| "You have the wrong person, I never signed up" | dnc | wrong recipient |
| "Stop emailing me you scammers" | handoff + dnc + AI-pause sentinel | abusive |
| "I want a refund" | handoff | refund decision = founder |
| "Thanks but no" | stop | polite decline |
| "Sure, I'll resubscribe" (followed by actual resub webhook) | recover | recovery detected |
| "C'est trop cher" | auto-reply in French OR handoff if low confidence | non-English |
| Third reply (`followupsSent === 2`) | handoff | `MAX_FOLLOWUPS` cap |
| "Who is this?" | auto-reply with brief context | confusion |
| "Can you delete my data" | handoff | GDPR-adjacent |
| Reply from address that doesn't match original to-address | thread correctly, no new subscriber row | threading |

**Cost:** 12 × \$0.003 = ~\$0.04 per run.
**Acceptance:** 12/12 pass.

### Sweep E — Layer 2.D: re-engagement / changelog match

**Goal:** catch regressions in the changelog-match cron.

**Files:**
- `src/winback/__tests__/fixtures/changelog-match/` — fixtures of
  `{changelogText, subscribers: [{triggerNeed, reasonCategory}, ...], expected: { matchedIds: string[], emailQualityChecks: {...} }}`.
- `src/winback/__tests__/changelog-match-golden.test.ts` — calls
  `matchChangelogToSubscribers()`, asserts the right subscribers are matched
  and the generated win-back email references the changelog concretely.

**Scenarios (~8 total):**

| Changelog | Subscribers | Expected match |
|---|---|---|
| "Added SSO" | `triggerNeed='SSO'` | match, email mentions SSO |
| "Added SSO" | `reasonCategory='price'` | no match |
| "Fixed dashboard crash" | `triggerNeed='dashboard reliability'` | match |
| "Internal refactor of billing engine" | any | no match (no user-visible change) |
| "Added Outlook integration" | `triggerNeed='Gmail integration'` | no match (different product) |
| 100 subscribers, 1 changelog | mixed | batched LLM call, no >1 email per (sub, changelog) |
| Changelog edited after match | matched subscribers | original match preserved, no duplicate |
| Changelog text empty / null | any | no-op, no LLM call, no email |

**Cost:** ~8 × \$0.003 + ~5 × \$0.003 email-gen = ~\$0.04 per run.
**Acceptance:** 8/8 pass.

### Sweep F — Layer 3 manual e2e checklist

**Goal:** human runs this on dev before each prod release, ~30 min.

**Files:**
- `specs/regression-winback-e2e.md` — checklist doc, lives on `main`.

**Test environment:** dev (`localhost:3000` + ngrok), merchant
`tejaasvi@gmail.com`, Stripe sandbox `tkedambadi@gmail.com`. Reset state with
`scripts/billing-test-reset.ts` before starting.

**Subscriber-facing walk-throughs** (read the actual email in a real Gmail):

1. **Tier 1 — explicit price reason.** Create a sandbox subscriber, cancel
   with comment "$99 is too much right now." Verify email arrives in
   ≤60s, opens with a validation beat, references price specifically, is
   ≤120 words, plain text, threaded correctly. Reply "can you do 50%?" —
   verify no auto-reply arrives (handoff).
2. **Tier 1 — explicit feature reason.** Cancel with "no SSO support."
   Verify email mentions SSO. Reply "still need it." Verify auto-reply
   arrives, `triggerNeed` is set in DB. Publish changelog "added SSO" —
   verify re-engagement email arrives within 1 cron cycle, references SSO
   concretely.
3. **Tier 3 — silent churn.** Cancel with no comment, reason='other'.
   Verify email arrives, opens softly, asks one open question.
4. **Tier 4 — suppress.** Trial subscriber cancels day 1 with no comment.
   Verify *no email is sent* and a `wb_events` row records the suppress.
5. **DNC.** Subscriber clicks the unsubscribe `mailto:` link. Verify the
   next changelog match does not email them.
6. **Threading.** Subscriber replies from a different address (forward,
   alias). Verify thread resolves correctly in the dashboard.

**Merchant-facing walk-throughs** (click through `/admin` and `/dashboard`):

1. For each scenario above, the subscriber appears with the correct status
   badge: Recovered / Contacted / Pending / Lost.
2. **Handoff list.** `/admin/handoffs` (or wherever it lives) shows the
   price-negotiation reply with the reply text + handoff reason.
3. **AI-pause toggle.** Toggle AI-pause on a single subscriber. Within
   60s, no further AI sends should fire for that subscriber. Toggle off,
   verify normal flow resumes.
4. **Customer-level win-back pause.** Pause the win-back cohort in
   `/settings`. Verify (a) no new win-back emails go out, (b)
   payment-recovery emails *do* still go out (independent cohort per Spec 55).
5. **Per-event log.** Every gate skip + every send is visible in
   `/admin/events`.

**Cost:** ~30 min human time + ~\$0.05 LLM cost per full run.
**Acceptance:** every item in the checklist passes.

## Code paths touched (full list)

- New: `src/winback/__tests__/fixtures/{classifier,replies,changelog-match}/**`
- New: `src/winback/__tests__/{tier-resolution,gate-matrix,inbound-threading,idempotency,classifier-golden,first-email-quality,reply-handling,changelog-match-golden}.test.ts`
- New: `src/winback/__tests__/email-quality-judge.ts`
- New: `specs/regression-winback-e2e.md` (sweep F)
- Modified: `package.json` — add `test:llm` script that sets `RUN_LLM_TESTS=1`
- Modified: `.github/workflows/*.yml` (if CI) — opt-in LLM test job, manual dispatch only, with budget cap.
- No schema changes. No migration. No runtime behaviour changes.

## Edge cases (called out for fixture authoring)

- Empty `stripeComment`, null `stripeEnum`, no `replyText` → Tier 3 silent churn path.
- Subscriber with `tenureDays < 7` and no comment → likely Tier 4 suppress (low recovery probability).
- Multilingual reply → AI should reply in same language or hand off if confidence low.
- Reply contains another email forwarded inline → AI must not treat the
  forwarded text as the subscriber's words.
- Subscriber with very high `mrrCents` (\$500+) + explicit feature ask →
  hand off even if AI could in principle reply, because the dollar
  weight makes founder time worth it.
- Reply from inside the same thread but with subject prefix translated
  ("Re: ..." vs "AW: ..." vs "RE:" + ASCII vs Unicode dashes) →
  threading must still match.
- Customer paused win-back mid-thread → in-flight replies are dropped,
  not auto-replied.

## Verification checklist (for each sweep PR)

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` clean (existing tests still green)
- [ ] New tests in the sweep all green
- [ ] If sweep is Layer 2: `RUN_LLM_TESTS=1 npx vitest run` clean, cost
      logged in PR description (target ≤ \$0.30 full run)
- [ ] PR description references "Spec 63 sweep X"
- [ ] No schema / runtime code changes outside the test directory
      (the spec is explicit about no behaviour changes)

## Open questions to resolve before sweep A starts

1. **Where do golden fixtures live in git?** Proposal: `src/winback/__tests__/fixtures/classifier/{category}/*.json`. Each fixture ≤2KB. Sanity-cap the directory at ~100 files.
2. **How do we keep fixtures fresh?** Proposal: when a real classifier
   regression escapes to prod, the fix PR adds the missed scenario as a
   new fixture. The suite grows monotonically.
3. **CI cost guardrail.** Proposal: full Layer-2 run only on `workflow_dispatch`
   or on PRs labeled `ai-changes`. Layer 1 runs on every PR.
4. **Who owns the judge rubric?** Proposal: the rubric file
   (`first-email-quality.rubric.md`) is checked in, edits require human review,
   the judge LLM cites the rubric clause it failed against in `failures[]`.

## Roll-back plan

The whole suite is opt-in via `RUN_LLM_TESTS=1`. If a sweep introduces
flakes that block CI, revert that sweep's PR. Layer 1 sweeps are
deterministic — a flake there is a real bug.

# Spec 19 — Semantic changelog matching + concrete win-back emails

**Phase:** Next up (April 2026)
**Depends on:** None (no schema migrations required for 19a; 19b adds a column)

---

## Summary

Three connected upgrades to the changelog → win-back pipeline. Each is independently
shippable, but they're listed together because they share a single underlying shift:
moving from *substring matching* and *pre-written templates* to *semantic
understanding* and *concrete, situation-specific content*.

| Phase | Change | Schema impact |
|------|--------|---------------|
| 19a | Replace `ILIKE` with LLM re-rank | None |
| 19b | Replace `trigger_keyword` (short string) with `trigger_need` (rich description) | Add column, backfill, deprecate old column |
| 19c | Generate win-back email body at match time, referencing actual changelog | None — stop using pre-written `winBackBody` |

**Recommended sequence:** Ship 19a alone first (small, no schema risk, immediate value).
Land 19b + 19c together once 19a is proven (they reinforce each other and land
cleanly with one prompt change).

---

## Context: what's actually broken

`app/api/changelog/route.ts` matches changelog text against each subscriber's
`triggerKeyword` using `ILIKE '%' || trigger_keyword || '%'`. This compares letters,
not meaning:

- Subscriber wanted "csv export" → changelog mentions "spreadsheet downloads" → **miss**
- Subscriber wanted "zapier" → changelog mentions "workflow automation" → **miss**
- Subscriber wanted "api" → changelog mentions "happy users" → **false positive** (matches "happy")

When matches fire, we send `winBackBody` — a generic template the classifier wrote at
churn time, before the fix existed. It can't reference what actually shipped, so it
reads like marketing ("we made improvements") rather than concrete signal ("we
shipped X yesterday — here's how it works").

These limitations are linked. ILIKE forced us to store keywords short enough to
substring-match, which limited match quality. Pre-writing the email forced generic
language because the classifier didn't know the future. Fixing one and not the
others leaves value on the table.

### Why this matters in the recovery funnel

Subscribers don't come back from win-back emails being eloquent. They come back
through replies and clicks. Concrete, specific emails get more replies and clicks
than generic ones. Better matching surfaces more eligible subscribers in the first
place. Both improvements push the same lever: **more conversation hooks land**.

See `docs/semantic-matching-explainer.html` for an interactive walkthrough.

---

## Phase 19a — LLM re-rank replaces ILIKE

### What changes

**File:** `app/api/changelog/route.ts`

Replace the ILIKE clause with a broader candidate query, then run a single LLM call
to decide which candidates are genuinely addressed by the changelog.

```ts
// 1. Cheap SQL filter — fetch all eligible candidates
const candidates = await db
  .select()
  .from(churnedSubscribers)
  .where(
    and(
      eq(churnedSubscribers.customerId, customer.id),
      inArray(churnedSubscribers.status, ['pending', 'contacted']),
      eq(churnedSubscribers.doNotContact, false),
      isNotNull(churnedSubscribers.triggerKeyword),
      isNotNull(churnedSubscribers.winBackBody),
      isNull(churnedSubscribers.reengagementSentAt),
    )
  )

if (candidates.length === 0) {
  return NextResponse.json({ success: true, keywordsFound, matchesFound: 0 })
}

// 2. One LLM call decides which match
const matchedIds = await matchChangelogToSubscribers(
  content,
  candidates.map(c => ({ id: c.id, triggerKeyword: c.triggerKeyword! })),
)

// 3. Send to matched only — existing send/log/update loop unchanged
const matchedSubs = candidates.filter(c => matchedIds.has(c.id))
for (const sub of matchedSubs) {
  // ... existing logic
}
```

### New utility

**File:** `src/winback/lib/changelog-match.ts` (new)

```ts
export async function matchChangelogToSubscribers(
  changelogText: string,
  candidates: Array<{ id: string; triggerKeyword: string }>,
): Promise<Set<string>>
```

- Single Haiku call, temperature 0, max_tokens ~500
- System prompt: "You decide whether each subscriber's stated concern is addressed
  by the changelog. Be strict — synonym, paraphrase, or feature equivalence is fine,
  but tangential mentions don't count. Return JSON object mapping each id to
  true/false."
- Parse with Zod (`z.record(z.string(), z.boolean())`)
- Return Set of IDs marked true
- Fail closed: if the LLM call or parse fails, return empty Set + log error
- Batch size: all candidates in one call (chunk into batches of 50 if > 100)

### Failure handling

If the re-rank call fails: 0 matches sent + `matchError: true` in response so the
dashboard can surface "Matching unavailable, try again."

### Cost

- Today: 1 keyword extraction call per changelog post (~$0.001)
- After 19a: extraction + re-rank = ~$0.002 per changelog post
- Net: +$0.001 per changelog. Negligible.

---

## Phase 19b — Rich need descriptions replace short keywords

### What changes

The `trigger_keyword` column was shaped by ILIKE's need for short, literal text.
Once matching is semantic (19a), we can store a richer description that captures
*why* the subscriber wanted the thing, not just a one-word label.

| Before | After |
|--------|-------|
| `"csv export"` | `"Wants to export their data to a spreadsheet for their accountant"` |
| `"slack"` | `"Asked for Slack notifications when new orders come in"` |
| `"zapier"` | `"Wants to connect to other tools via Zapier or any general workflow automation platform"` |

### Schema change

**Migration:** `src/winback/migrations/012_trigger_need.sql`

```sql
ALTER TABLE wb_churned_subscribers
  ADD COLUMN trigger_need TEXT;

-- Backfill from existing trigger_keyword for continuity
UPDATE wb_churned_subscribers
  SET trigger_need = trigger_keyword
  WHERE trigger_need IS NULL AND trigger_keyword IS NOT NULL;

-- Keep trigger_keyword for now — drop in a later migration once we're confident
```

**Drizzle schema** (`lib/schema.ts`):
```ts
triggerNeed: text('trigger_need'),
// Keep triggerKeyword for backwards compatibility during transition
```

### Classifier change

**File:** `src/winback/lib/classifier.ts`

- Add `triggerNeed` to `ClassificationSchema` (required string, max 200 chars)
- Update system prompt: "triggerNeed: a 1–2 sentence description of what the
  subscriber wanted, in their own words where possible. This will be used to
  match against future product updates. Be specific enough that an LLM can
  decide if a future feature addresses it."
- Keep `triggerKeyword` for backwards compat — populate it as the first 1-3 words
  of `triggerNeed` for legacy callers, or just remove it from the LLM output and
  derive at write time

### Match prompt update

**File:** `src/winback/lib/changelog-match.ts`

Use `triggerNeed` instead of `triggerKeyword`:

```ts
candidates.map(c => ({ id: c.id, triggerNeed: c.triggerNeed! }))
```

The LLM has more signal to work with. Match accuracy improves without changing the
matcher logic itself.

### Backfill strategy

For existing subscribers with only `triggerKeyword`:
- Option A: Bulk re-classify them via the cron — expensive but high quality
- Option B: Use the keyword directly as the need (the migration's `UPDATE` handles
  this) — degraded quality but free

**Recommendation:** Option B. New cancellations get rich needs immediately;
existing subscribers degrade gracefully.

---

## Phase 19c — Generate win-back email at match time

### What changes

Stop pre-writing `winBackBody` at churn time. Instead, generate a concrete,
specific email at match time using:
- The subscriber's `triggerNeed` (what they wanted)
- The actual changelog text (what shipped)
- The founder's voice (from the original `firstMessage` style)

### Where the change lives

**File:** `src/winback/lib/changelog-match.ts`

After `matchChangelogToSubscribers()` returns matched IDs, generate emails:

```ts
export async function generateWinBackEmail(
  changelogText: string,
  subscriber: { triggerNeed: string; name: string | null; firstName?: string },
  founderName: string,
): Promise<{ subject: string; body: string }>
```

- Single Haiku call per matched subscriber
- System prompt instructs: write a specific, concrete email referencing what
  shipped. Mention the actual feature/fix from the changelog. Don't oversell.
  End with a single low-pressure question or a "want to give it a try?"

### Classifier change

**File:** `src/winback/lib/classifier.ts`

- Stop generating `winBackSubject` / `winBackBody` at churn time
- Remove from `ClassificationSchema` (or keep as deprecated)
- This drops per-churn cost from ~$0.003 to ~$0.002

### Cost shift

- Per churn: -$0.001 (no winBackBody generation)
- Per match: +$0.001 per matched subscriber
- Net: roughly flat (matches happen far less often than churns)
- **Quality gain:** every win-back email is now concrete and specific

### Backwards compatibility

Existing subscribers have `winBackBody` populated. The new flow ignores it. No
data loss; just dormant data we stop reading.

---

## Files to modify (full set across all phases)

| File | Phase | Change |
|------|-------|--------|
| `src/winback/lib/changelog-match.ts` | 19a | **New** — `matchChangelogToSubscribers()` |
| `app/api/changelog/route.ts` | 19a | Remove ILIKE, add re-rank step |
| `src/winback/__tests__/changelog-match.test.ts` | 19a | **New** — mock Anthropic, verify parsing + Set output + failure modes |
| `src/winback/migrations/012_trigger_need.sql` | 19b | **New** — add column + backfill |
| `lib/schema.ts` | 19b | Add `triggerNeed` field |
| `src/winback/lib/classifier.ts` | 19b, 19c | Add `triggerNeed` to schema + prompt; remove `winBackBody` generation |
| `src/winback/lib/changelog-match.ts` | 19b, 19c | Use `triggerNeed`; add `generateWinBackEmail()` |
| `app/api/changelog/route.ts` | 19c | Call `generateWinBackEmail()` per matched sub instead of using `sub.winBackBody` |
| `docs/ai-engine-design.html` | all | Update Changelog node, Send Win-back Email node, mark priority row 3 DONE |

---

## Verification

### 19a
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` green
- [ ] Test (mocked LLM): 3 candidates, LLM returns `{a: true, b: false, c: true}` → only a + c get win-back emails
- [ ] Test: LLM call fails → 0 matches sent, `matchError: true` in response
- [ ] Test: 0 candidates → no LLM call made (short-circuit)
- [ ] Test: synonym match (`triggerKeyword: "csv export"`, changelog: `"spreadsheet downloads"`) → with mocked true, email sent
- [ ] Manual: post a paraphrased changelog in dev, verify match works where ILIKE would have missed

### 19b
- [ ] Migration applied to Neon, existing rows backfilled
- [ ] New cancellations populate `triggerNeed` with rich descriptions
- [ ] Classifier output validated against new Zod schema
- [ ] Re-rank uses `triggerNeed` and produces equal-or-better match quality on a hand-graded sample of 20 cases

### 19c
- [ ] Per-churn LLM cost drops (no `winBackBody` generated)
- [ ] Per-match emails reference actual changelog content (verify on 5 sample matches)
- [ ] No emails sent before LLM generates body successfully (fail closed — log + skip if generation fails)
- [ ] Existing `winBackBody` data unchanged (just unread)

### End-to-end
- [ ] Trigger a real changelog post in dev with deliberately paraphrased text
- [ ] Verify `wb_events` shows `email_sent` rows for matched subscribers
- [ ] Verify the actual email body (in Resend dashboard) references the changelog specifically

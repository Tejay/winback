# Spec 16 — Time decay re-engagement + smart backfill

**Phase:** In progress (April 2026)
**Depends on:** Spec 03 (classifier + email), Spec 15 (signal sources fix)

---

## Summary

Two related gaps:

1. **Time decay is unbuilt.** The classifier outputs `fallbackDays` but the value is
   never stored or consumed. Subscribers who don't reply, don't recover, and don't
   match a changelog keyword sit in `'contacted'` status forever.

2. **Backfill over-emails.** When a customer connects Stripe, we pull up to 1 year
   of cancellations and run each through the classifier. Every subscriber gets a
   full LLM call (~$0.003), even silent churners with no signal data. And old
   cancellations can get exit emails despite being months stale.

### Design decisions

- **Single 90-day backstop** — not LLM-picked 30/90/180. We can't predict subscriber
  receptivity for passive churners, so we use a fixed interval. One last try, then
  they're done.
- **Smart backfill classification** — only call the LLM when there's actual signal
  to interpret (stripeComment or stripeEnum). Silent churners get deterministic
  defaults without an LLM call, saving ~60-70% of classification costs.
- **7-day email cutoff for backfill** — only email subscribers who cancelled < 7 days
  ago during backfill. Older ones are classified for dashboard data and trigger
  keywords but not emailed. They wait for event-driven triggers (changelog match).
- **Event-driven for historical** — old backfill subscribers are eligible for
  changelog-triggered win-back emails (their triggerKeyword is set) but NOT for
  the time-decay backstop (they never got an exit email from us).

---

## What changes

### New files

| File | Purpose |
|------|---------|
| `src/winback/migrations/011_time_decay.sql` | Add `fallback_days`, `reengagement_sent_at`, `reengagement_count` columns + index |
| `app/api/cron/reengagement/route.ts` | Daily cron — finds eligible subscribers, re-classifies, sends re-engagement email |
| `src/winback/__tests__/reengagement.test.ts` | Tests for the cron logic |

### Modified files

| File | Change |
|------|--------|
| `lib/schema.ts` | Add 3 columns to `churnedSubscribers` |
| `src/winback/lib/types.ts` | Add `'reengagement'` to `EmailType`; remove `fallbackDays` from `ClassificationResult` |
| `src/winback/lib/classifier.ts` | Remove `fallbackDays` from Zod schema (no longer LLM-decided) |
| `app/api/stripe/webhook/route.ts` | Persist `fallbackDays: 90` on insert |
| `src/winback/lib/backfill.ts` | Smart classification (skip LLM for silent churn); 7-day email cutoff; persist `fallbackDays: 90` |
| `app/api/changelog/route.ts` | Skip subscribers who already got a re-engagement email |
| `vercel.json` | Add cron: `/api/cron/reengagement` daily at 09:00 UTC |
| `docs/ai-engine-design.html` | Update Time Decay node status |

---

## Design details

### Smart backfill classification

When processing historical cancellations at first Stripe connect:

**Has stripeComment (free text):** Full LLM classify — real signal to extract reason,
trigger keyword, win-back content. Cost: $0.003

**Has stripeEnum only (e.g. `too_expensive`):** Full LLM classify — the enum provides
enough signal for a meaningful classification and trigger keyword.

**Silent churn (no enum, no comment):** Skip LLM entirely. Set deterministic defaults:
```
tier: 3
cancellationCategory: 'Other'
cancellationReason: 'No reason given'
triggerKeyword: null
confidence: 0.3
suppress: false
```

This saves ~60-70% of LLM calls during backfill (most cancellations are silent).

### Backfill email rules

| Cancellation age | Classified? | Emailed? | Time-decay eligible? |
|-----------------|:-----------:|:--------:|:-------------------:|
| < 7 days | Yes (LLM if signal, defaults if silent) | Yes (exit email) | Yes (status = 'contacted') |
| 7+ days | Yes (LLM if signal, defaults if silent) | No | Changelog trigger only |

### Time-decay cron

**Schedule:** Daily at 09:00 UTC

**Eligibility query:**
- `status IN ('pending', 'contacted')` — must have been emailed
- `source = 'webhook'` OR `(source = 'backfill' AND status = 'contacted')` — backfill subscribers only if they got an email
- `reengagement_count < 1` — max one attempt
- `do_not_contact = FALSE`
- `email IS NOT NULL`
- `cancelled_at + 90 days <= now()`

**Per subscriber:**
1. Skip if customer paused
2. Skip if `win_back` email already exists (changelog already triggered)
3. Re-classify with fresh context (current changelog, elapsed time)
4. If suppress → increment `reengagement_count`, don't send
5. If non-suppress → send via `sendEmail()`, record as type `'reengagement'`

### Guardrails

- Max 1 re-engagement per subscriber
- Respect DNC / unsubscribe / customer pause
- No double-contact with changelog (check for existing `win_back` email)
- Batch limit of 50 per cron run (serverless timeout safety)
- Re-classification suppress increments count (prevents retry)

---

## Verification

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run` — all tests green
- [ ] Migration applied to Neon
- [ ] New real-time cancellation has `fallback_days = 90` in DB
- [ ] Backfill: silent churner skips LLM (check logs for "deterministic classification")
- [ ] Backfill: subscriber cancelled 30 days ago is classified but NOT emailed
- [ ] Backfill: subscriber cancelled 3 days ago IS emailed
- [ ] Cron route returns 401 without CRON_SECRET
- [ ] Cron processes eligible subscribers correctly
- [ ] Changelog route skips re-engaged subscribers
- [ ] Existing flows unaffected (exit email, reply follow-up, dunning)

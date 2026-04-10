# Spec 07 — Billing Calculation + Changelog Trigger

**Phase:** 7
**Depends on:** Spec 04 (classifier, email), Spec 05 (wb_recoveries data)
**Estimated time:** 2 hours
**Human checkpoints:** 2

---

## Part A — Update app/api/changelog/route.ts

In Phase 3, this route only saved text. Now extend it to also trigger win-back emails.

**Updated `POST /api/changelog`:**
1. Save `content` to `wb_customers.changelog_text`
2. Call LLM to extract keywords:
   ```
   Model: claude-haiku-4-5-20251001, temperature: 0, max_tokens: 200
   System: "Return ONLY a JSON array of lowercase keyword strings. No other text."
   User: "Extract 3-8 keywords from this changelog. Focus on feature names,
          integration names, and bug fixes. Example output: ["zapier","csv","calendar"]
          Changelog: {content}"
   ```
3. Parse JSON array from LLM response. Zod validate: `z.array(z.string())`
4. For each keyword, query `wb_churned_subscribers`:
   ```sql
   WHERE customer_id = {customerId}
   AND status IN ('pending', 'contacted')
   AND trigger_keyword IS NOT NULL
   AND win_back_body IS NOT NULL
   AND {changelog_content} ILIKE '%' || trigger_keyword || '%'
   ```
5. For each matched subscriber: send `win_back_body` email using `sendEmail`
6. Insert row into `wb_emails_sent` (`type: 'win_back'`)
7. Return `{ keywordsFound: string[], matchesFound: number }`

⛔ **CHECKPOINT:**
"Ready to run end-to-end changelog test. This sends one real email to verify matching works. Type 'yes'."

Manual test setup:
- Insert a test subscriber with `trigger_keyword='zapier'`, `status='pending'`, valid `win_back_body` and `email`
- `POST /api/changelog { content: "Added Zapier integration today" }`
- Confirm: win-back email received, subscriber status updated

---

## Part B — src/winback/lib/billing.ts

```typescript
export interface MonthlyFee {
  baseFeeCents:            number   // always 4900 (£49)
  recoveredMrrActiveCents: number   // sum of MRR from still-active recoveries
  successFeeCents:         number   // 10% of recoveredMrrActiveCents
  successFeeCappedCents:   number   // min(successFee, 50000) — £500 cap
  totalFeeCents:           number   // base + cappedSuccessFee
  recoveredSubscribers: Array<{
    email:       string
    mrrCents:    number
    recoveredAt: Date
    stillActive: boolean
  }>
}

export async function calculateMonthlyFee(customerId: string): Promise<MonthlyFee>
```

**Formula:**
```
success_fee = recoveredMrrActive × 0.10
total = 4900 + min(success_fee, 50000)
```

**For each `wb_recoveries` row where `still_active = true` AND `attribution_ends_at > NOW()`:**
1. Fetch current subscription from Stripe using customer's decrypted access token
2. If subscription is cancelled or missing → set `still_active = false` in database, exclude from fee
3. If active → include `plan_mrr_cents` in `recoveredMrrActive`

⛔ **CHECKPOINT — before writing tests:**
Show this example:
```
Example: 5 subscribers recovered at £39/mo each
  recoveredMrrActive = £195/mo
  successFee = £19.50/mo
  total = £49 + £19.50 = £68.50/mo

no cap.
```
Ask: "Is this billing formula correct? Type 'yes'."

---

## Part C — GET /api/billing/preview

- Requires auth session
- Returns `calculateMonthlyFee(customerId)` for the current user's customer
- Used by the Settings billing section to show real numbers (future enhancement)

---

## Tests (src/winback/__tests__/billing.test.ts)

Mock Stripe calls — do not make real API calls in tests.

1. No recoveries → `baseFeeCents = 4900`, `totalFeeCents = 4900`
2. One active recovery at £39/mo (3900 cents) → `successFeeCents = 390`, `totalFeeCents = 5290`
3. Inactive recovery (`still_active = false`) → excluded, `totalFeeCents = 4900`
4. Recovery older than 12 months (`attribution_ends_at` in past) → excluded

Run tests and show output to human: "Do these fee calculations look correct? Type 'yes'."

---

## Definition of done
- [ ] Changelog route extracts keywords and sends win-back emails to matched subscribers
- [ ] End-to-end test confirmed (real email sent and received)
- [ ] `calculateMonthlyFee` correct for all 5 scenarios
- [ ] £500 cap applies correctly
- [ ] `/api/billing/preview` returns correct data
- [ ] All billing tests passing
- [ ] Human confirmed formula and test numbers

# Spec 18 — Fix attribution: replace hardcoded 'weak' with evidence-based logic

**Phase:** Next up (April 2026)
**Depends on:** Spec 17 (outcome events — ideally land together for clean recovery tracking)

---

## Summary

`processRecovery()` in the webhook route hardcodes `attributionType: 'weak'` for every
`customer.subscription.created` event. The only check is whether we sent *any* email
to the subscriber — if yes, it's `'weak'`. This is too loose:

- A subscriber who clicked our reactivation link → still marked `'weak'`
- A subscriber who resubscribed 6 months after our email with no interaction → `'weak'`
- A subscriber who replied, engaged, and came back → still `'weak'`

Meanwhile, billing only charges for `'strong'` attribution. So even subscribers we
genuinely helped are often recorded as `'weak'` and generate $0 revenue.

---

## Current attribution paths

| Recovery path | File + function | Current logic | Correct? |
|---|---|---|---|
| `subscription.created` webhook | `processRecovery()` line 214 | Hardcoded `'weak'` if any email was sent | **No** — should check for evidence of engagement |
| `checkout.session.completed` webhook | `processCheckoutRecovery()` line 251 | Hardcoded `'strong'` (Winback checkout metadata) | **Yes** — subscriber clicked our link |
| `invoice.payment_succeeded` webhook | `processPaymentSucceeded()` lines 427-449 | Dynamic: `'strong'` if portal clicked, `'weak'` if payment method changed, skip if same card | **Yes** — proper evidence-based logic |
| Reactivation link (resume) | `app/api/reactivate/[subscriberId]/route.ts` line 64 | `'strong'` | **Yes** — clicked our link |

Only `processRecovery()` needs fixing.

---

## The fix: evidence-based attribution in processRecovery()

Replace the hardcoded `'weak'` with conditional logic that checks for evidence
of subscriber engagement:

```ts
// Determine attribution based on evidence of engagement
let attributionType: string

if (churned.billingPortalClickedAt) {
  // Subscriber clicked our billing portal link — strong evidence
  attributionType = 'strong'
} else {
  // Check how recently we contacted them and if they engaged
  const [recentEmail] = await db
    .select({ sentAt: emailsSent.sentAt, repliedAt: emailsSent.repliedAt })
    .from(emailsSent)
    .where(eq(emailsSent.subscriberId, churned.id))
    .orderBy(desc(emailsSent.sentAt))
    .limit(1)

  if (recentEmail?.repliedAt) {
    // They replied to our email — strong causation signal
    attributionType = 'strong'
  } else if (recentEmail?.sentAt) {
    // We emailed but no tracked engagement — check recency
    const daysSinceEmail = Math.floor(
      (Date.now() - recentEmail.sentAt.getTime()) / (1000 * 60 * 60 * 24)
    )
    if (daysSinceEmail <= 14) {
      // Resubscribed within 14 days of our email — likely influenced
      attributionType = 'weak'
    } else {
      // Resubscribed long after our email — probably organic
      attributionType = 'organic'
    }
  } else {
    // No emails sent (shouldn't reach here due to earlier guard, but defensive)
    attributionType = 'organic'
  }
}
```

### Attribution decision matrix

| Portal clicked? | Replied to email? | Resubscribed within 14 days of email? | Attribution |
|:---:|:---:|:---:|---|
| Yes | — | — | **strong** |
| No | Yes | — | **strong** |
| No | No | Yes | **weak** |
| No | No | No | **organic** |
| — | — | No email sent | skip (existing behavior) |

### New attribution type: `'organic'`

For subscribers who resubscribed with no evidence of Winback influence. This is
more honest than `'weak'` — we're admitting we don't know if we helped.

- `'strong'` → Billable. Clear evidence: clicked our link, replied to our email.
- `'weak'` → Not billable but tracked. Some evidence: emailed recently, they came back.
- `'organic'` → Not billable, not counted as recovery in dashboard. Coincidence.

---

## Schema impact

The `recoveries.attributionType` column is `text` with default `'weak'` — no schema
change needed. `'organic'` is just a new value.

The billing system (`src/winback/lib/obligations.ts`) only bills `'strong'` attribution
(`BILLABLE_ATTRIBUTION = 'strong'`), so `'organic'` recoveries naturally contribute $0.

### Dashboard impact

The dashboard stats route (`app/api/stats/route.ts`) may need to decide whether to
count `'organic'` recoveries in the recovery count or not. Recommendation: show them
separately — "X strong recoveries, Y weak, Z organic" — so founders have full visibility.

---

## Files to modify

| File | Change |
|------|--------|
| `app/api/stripe/webhook/route.ts` | Replace hardcoded `'weak'` in `processRecovery()` with evidence-based logic; add `desc` import from drizzle-orm |
| `app/api/stats/route.ts` | Consider showing organic recoveries separately (optional) |

---

## Verification

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run` — all tests green
- [ ] Test: subscriber clicks billing portal → resubscribes → should be `'strong'`
- [ ] Test: subscriber replies to email → resubscribes → should be `'strong'`
- [ ] Test: subscriber resubscribes within 14 days of email, no clicks → should be `'weak'`
- [ ] Test: subscriber resubscribes 60 days after email, no clicks → should be `'organic'`
- [ ] Test: subscriber resubscribes with no emails sent → should be skipped (existing behavior)
- [ ] Billing logic unchanged — only `'strong'` is billable

# Spec 30 — Onboarding follow-up + dormant-account cleanup

**Phase:** Pre-launch growth + hygiene
**Depends on:** Spec 25 (admin role / `wb_users.is_admin`), existing
`/api/cron/reengagement` infrastructure, Resend founder-email pattern
**Estimated time:** ~5 hours

---

## Context

A founder registers via `POST /api/auth/register`. We create a
`wb_users` row + a blank `wb_customers` row, then redirect them to
`/onboarding/stripe`. If they never click **Connect Stripe**,
`wb_customers.stripe_account_id` and `stripe_access_token` stay NULL
**indefinitely**. Today there is **no follow-up** — these accounts:

- Receive **no nudge email** to come back
- Are **invisible** in `/admin/customers` (no filter for them)
- Don't show up in any **funnel analytics** (we log
  `onboarding_stripe_viewed` and `oauth_completed`, but not
  `register_completed` — so funnel drop-off can't be reconstructed cleanly)
- Are **kept forever**, even though they hold a verified email + a
  legal-acceptance record (Spec 11 GDPR debt)

This spec ships the minimum-viable treatment for that cohort.

---

## Goals

| # | Goal | Mechanism |
|---|------|-----------|
| 1 | Recover the founders who got distracted, with one polite nudge | Day-3 transactional email via Resend, fired by daily cron |
| 2 | Give the operator visibility for high-value manual outreach | New `/admin/customers?filter=stuck_on_signup` filter + "Days since signup" column |
| 3 | Make the funnel analytically complete | Emit `register_completed` event in the registration handler |
| 4 | Prune accounts that never connect within 90 days | Cascade-delete `wb_users` row on day 90; data minimisation aligns with future Spec 11 |

---

## Non-goals

- Multi-touch drip campaigns. **One** nudge total. If they ignore it, the
  in-app `/onboarding/stripe` redirect on next login is the second nudge,
  and the 90-day deletion is the cap.
- Email-based deletion warnings (e.g. "your account will be deleted in 7
  days"). The 90-day grace period is generous enough that a Day-83 second
  email isn't worth the spam-flag risk or the operational complexity.
- Tracking `last_login_at`. We deliberately don't add this column. The
  90-day clock is from `wb_customers.created_at`, period. If the founder
  is logging in but never connecting Stripe, the in-app redirect is
  doing its job — they have a clear next step every time.
- Sending emails for accounts created before Spec 30 lands. The cron
  query naturally excludes them from the nudge pass once
  `onboarding_nudge_sent_at` is non-null, but the prune pass *will* sweep
  pre-existing dormant accounts on its first run. **Mitigation: first
  prod cron run uses `?dryRun=1` for human review of the eligible set.**

---

## Detection (single SQL truth)

```sql
-- "Stuck on signup" cohort
SELECT u.id, u.email, c.id AS customer_id, c.created_at, c.onboarding_nudge_sent_at
FROM   wb_users u
JOIN   wb_customers c ON c.user_id = u.id
WHERE  c.stripe_account_id IS NULL
  AND  u.is_admin = false;

-- Eligible for nudge: 3 ≤ days_old < 90 AND not already nudged
-- Eligible for prune: days_old ≥ 90 AND no recoveries
```

---

## Database — migration 025

```sql
ALTER TABLE wb_customers
  ADD COLUMN onboarding_nudge_sent_at TIMESTAMP;

-- Partial index — only the eligible cohort, keeps the cron's WHERE clause cheap.
CREATE INDEX wb_customers_onboarding_nudge_idx
  ON wb_customers (created_at)
  WHERE stripe_account_id IS NULL AND onboarding_nudge_sent_at IS NULL;
```

Drizzle: add `onboardingNudgeSentAt: timestamp('onboarding_nudge_sent_at')`
to the `customers` pgTable in [lib/schema.ts](../lib/schema.ts).

**Why a column instead of querying `wb_events` for the audit?** `logEvent`
swallows insert errors (it's telemetry, not transactional). A dedicated
column gives us a transactional guarantee in the same UPDATE that follows
the email send, plus a cheap indexable timestamp the cron can put in its
WHERE clause.

---

## Cron route

`app/api/cron/onboarding-followup/route.ts`. Mirror
[reengagement/route.ts](../app/api/cron/reengagement/route.ts):

- `export const maxDuration = 60`
- Same `Bearer ${process.env.CRON_SECRET}` auth check
- Default `nodejs` runtime
- Accepts `?dryRun=1` query param (skip sends + skip deletes, log counts only)

**Why a separate cron, not folded into `/api/cron/reengagement`?**
Different concern (founder lifecycle vs. subscriber win-back), different
audit posture (the prune pass touches `wb_users`), different rollback story.
Mixing them muddies the single-responsibility line drawn in Spec 28.

Schedule (`vercel.json`): `30 9 * * *` — offset by 30 min from the existing
09:00 UTC reengagement cron so logs interleave cleanly.

The route delegates to two helpers in
`src/winback/lib/onboarding-followup.ts` so the passes are unit-testable
in isolation:

- `runOnboardingNudges({ dryRun }): Promise<{ processed, sent, errors }>`
- `runStaleAccountPrune({ dryRun }): Promise<{ processed, deleted, errors }>`

Response:
```json
{
  "nudges":  { "processed": N, "sent": M, "errors": E },
  "deletes": { "processed": N, "deleted": M, "errors": E },
  "dryRun":  false
}
```

### Pass A — nudge (Day ≥ 3, < 90)

Eligibility:

```ts
where(and(
  isNull(customers.stripeAccountId),
  isNull(customers.onboardingNudgeSentAt),
  eq(users.isAdmin, false),
  sql`${customers.createdAt} <= now() - interval '3 days'`,
  sql`${customers.createdAt} >  now() - interval '90 days'`,
)).limit(100)
```

Per-row sequence:

1. **Re-check** `stripeAccountId IS NULL` inside the loop (race: they may
   have connected between bulk-select and now)
2. `sendOnboardingNudgeEmail({ to: users.email, founderName: customers.founderName })`
3. `UPDATE wb_customers SET onboarding_nudge_sent_at = now() WHERE id = ?`
   — written **after** the send (matches reengagement precedent; one
   duplicate nudge on a transient Resend failure is acceptable)
4. `logEvent({ name: 'onboarding_nudge_sent', customerId, userId })`

Errors caught per-row, counter incremented, loop continues.

### Pass B — cascade prune (Day ≥ 90)

Eligibility:

```ts
where(and(
  isNull(customers.stripeAccountId),
  eq(users.isAdmin, false),
  sql`${customers.createdAt} <= now() - interval '90 days'`,
  // Defensive: never prune a customer that somehow has recoveries
  sql`NOT EXISTS (SELECT 1 FROM wb_recoveries r WHERE r.customer_id = ${customers.id})`,
)).limit(50)   // hard cap per run — drains a backlog over weeks rather than nuking 1k accounts in one tick
```

Per-row sequence:

1. **Audit-first**:
   ```ts
   logEvent({
     name: 'onboarding_account_pruned',
     customerId: null,        // important — see below
     userId,
     properties: { email, founderName, customerId, daysOld },
   })
   ```
   `customerId: null` so the audit row survives the cascade. The customer's
   UUID lives in `properties` for forensics. `userId` survives via
   `onDelete: 'set null'` on `wb_events.userId` (line 128 of schema).
2. `DELETE FROM wb_users WHERE id = ?` — cascades to:
   - `wb_customers` (line 16)
   - `wb_legal_acceptances` (line 102)
   - `wb_password_reset_tokens` (line 140)
   - `wb_events.customerId` rows (line 127) — fine, our prune event was
     written with `customerId: null`

Errors caught per-row.

---

## Email template

`src/winback/lib/email.ts`, appended after `sendPasswordResetEmail`. Same
shape: plain text, no DNC/AI-pause/footer machinery, **no unsubscribe
link**. This is a one-shot transactional message to a verified founder
who actively created an account; CAN-SPAM and UK GDPR carve out
relationship messages, and `sendPasswordResetEmail` is the established
precedent. The body's *"ignore this email and we won't send another"* +
the 90-day auto-prune commitment is the soft opt-out.

```ts
export async function sendOnboardingNudgeEmail(opts: {
  to: string
  founderName: string | null
}): Promise<void>
```

Subject: `Quick question — still want to set up Winback?`

Body:
```
Hi {founderName ?? 'there'},

You signed up for Winback a few days ago but haven't connected your Stripe yet.
Connecting takes about 90 seconds and is the only step between you and recovering
your first failed payment.

Pick up where you left off:
{NEXT_PUBLIC_APP_URL}/onboarding/stripe

If Winback isn't the right fit, no worries — you can ignore this email and we
won't send another. We'll clean up the unused account in 90 days.

If something blocked you (Stripe permissions, a question, anything), just hit reply.

— The Winback team
```

From: `Winback <noreply@winbackflow.co>`. Wrap in `callWithRetry` for 429
handling (matches `sendPasswordResetEmail`).

---

## Admin filter

[app/api/admin/customers/route.ts](../app/api/admin/customers/route.ts):

- Read `searchParams.get('filter')`.
- If `filter === 'stuck_on_signup'`, push
  `` sql`${customers.stripeAccountId} IS NULL` `` into the existing
  `filters: []` array.
- The route currently does `where(filters[0])` — fix to
  `where(and(...filters))` so `q=` and `filter=` stack.

[app/admin/customers/customers-client.tsx](../app/admin/customers/customers-client.tsx):

- New `useState<'all' | 'stuck_on_signup'>('all')` filter.
- Two-button toggle row above the search input: "All" / "Stuck on signup".
- Append `&filter=stuck_on_signup` to the fetch URL when set.
- Add a "Days since signup" column derived from `r.createdAt` so the
  filtered view is actionable for manual outreach.

---

## `register_completed` event

[app/api/auth/register/route.ts](../app/api/auth/register/route.ts) — after
the `legalAcceptances` insert, before the `NextResponse.json({ success: true })`:

```ts
await logEvent({
  name: 'register_completed',
  userId: newUser.id,
  properties: { hasName: !!name },
})
```

`logEvent` swallows errors so this can never 500 the registration.

This makes the founder funnel reconstructable end-to-end:

```
register_completed → onboarding_stripe_viewed → oauth_completed
                         ↓ (drop-off)              ↓ (drop-off)
                  onboarding_nudge_sent      onboarding_account_pruned
```

---

## Tests

Pattern: heavy `vi.hoisted` mocks of `@/lib/db`, `@/lib/schema`,
`drizzle-orm`. Mirrors
[billing-notifications.test.ts](../src/winback/__tests__/billing-notifications.test.ts)
and the password-reset route tests from Spec 29.

`src/winback/__tests__/onboarding-nudge-email.test.ts` (5 tests):
- Sends with subject containing "set up Winback"
- Body includes `${NEXT_PUBLIC_APP_URL}/onboarding/stripe`
- Null `founderName` → "Hi there"
- Resend error throws (caller handles)
- Skips silently when `RESEND_API_KEY` unset

`src/winback/__tests__/onboarding-followup-cron.test.ts` (10 tests):
- Nudge: skips when `stripeAccountId` set
- Nudge: skips when already nudged (`onboardingNudgeSentAt` not null)
- Nudge: skips users < 3 days old
- Nudge: skips `users.isAdmin = true`
- Nudge: writes `onboarding_nudge_sent_at` after successful send
- Nudge: continues when one row's send throws
- Prune: skips < 90 days
- Prune: skips when `stripeAccountId` set
- Prune: respects `dryRun`
- Prune: caps at 50 rows
- Prune: writes audit event with `customerId: null` BEFORE delete

`src/winback/__tests__/admin-customers-filter.test.ts` (3 tests):
- `filter=stuck_on_signup` adds the IS NULL clause
- `filter=stuck_on_signup` + `q=foo` stacks
- Unknown filter is ignored

Update `src/winback/__tests__/events.test.ts` if it whitelists names — add
`register_completed`, `onboarding_nudge_sent`, `onboarding_account_pruned`.

---

## Verification before merge

Per CLAUDE.md:

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run` — all green
- [ ] Migration 025 applied to Neon (show SQL, wait for "yes")
- [ ] **First prod cron run uses `?dryRun=1`** — review the eligible-prune
      list before allowing a real delete
- [ ] Local cron click-through:
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" \
    'http://localhost:3000/api/cron/onboarding-followup?dryRun=1'
  # backdate a test customer's created_at, then real run:
  curl -H "Authorization: Bearer $CRON_SECRET" \
    'http://localhost:3000/api/cron/onboarding-followup'
  ```
- [ ] Manual UI walk-through:
  - Register fresh test account → `wb_events` has `register_completed`
  - Backdate customer to 4 days ago → run cron → Resend dashboard shows
    the email + `onboarding_nudge_sent_at` is set + `wb_events` has
    `onboarding_nudge_sent`
  - Visit `/admin/customers?filter=stuck_on_signup` → only the test row
  - Backdate to 91 days, real run → cascade delete confirmed
    (`SELECT * FROM wb_users WHERE id = '<test-id>'` returns 0 rows;
    legal-acceptances, password-reset-tokens also gone; `wb_events` has
    the audit row with `customerId: null`)
- [ ] PR opened with explicit migration callout
- [ ] Human says "merge"

---

## Edge cases handled

1. **Race: Stripe connected between cron tick and send** — re-check
   `stripeAccountId IS NULL` in the per-row loop right before sending.
2. **Internal accounts** (e.g. `tejaasvi@gmail.com`,
   `support@winbackflow.co`) — excluded via `users.is_admin = false` in
   both passes. Column already exists from Spec 25.
3. **Bounced typo'd emails** — Resend marks undeliverable; auto-prune at
   90 days resolves it. No special handling.
4. **Crash mid-batch** — per-row try/catch with continue. Send-then-update
   means a transient Resend failure could re-send tomorrow; one duplicate
   nudge in N years is acceptable.
5. **Recoveries on a non-Stripe customer** — impossible by data flow
   (recoveries come from connected-Stripe webhooks), but the
   `NOT EXISTS (SELECT 1 FROM wb_recoveries WHERE customer_id = ?)` guard
   makes the prune safe even if the invariant is ever broken.
6. **First prod run sweeps pre-existing dormant accounts** — first run
   must be `?dryRun=1` so the human can audit the prune list before
   enabling real deletes.

---

## Out of scope (future)

- Spec 11 GDPR — once shipped, the prune logic here should defer to the
  retention-policy table rather than hard-coding 90 days.
- "Reactivate within 30 days" UX — letting a deleted founder restore
  their old account by clicking a link in their inbox. Acceptable
  alternative is just re-registering.
- A/B testing nudge subject lines.

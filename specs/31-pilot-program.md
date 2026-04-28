# Spec 31 — Pilot program (free 30-day trial for up to 10 founders)

**Phase:** Pre-launch validation
**Depends on:** Spec 23 (platform billing), Spec 25 (admin role), Spec 29
(token pattern), Spec 30 (admin filter UI + onboarding cron)
**Estimated time:** ~6 hours

---

## Context

We're a few weeks from public launch. Goal: run a private pilot with up
to ~10 hand-picked founders so we shake out bugs in the live
`/dashboard` → Stripe-connect → recovery → win-back flow without any of
them paying. Pilot founders go through the **regular signup +
Stripe-connect path** — no special onboarding, no separate dashboard —
but the system never charges them for:

- The **$99/mo platform fee** (Spec 23 — Stripe Subscription on Winback's
  own platform Stripe, normally created by `ensurePlatformSubscription`)
- The **1× MRR performance fee** per voluntary win-back (normally added
  to that subscription as an invoice item by `chargePerformanceFee`)

**Distribution model:** admin generates a **unique single-use signup URL
per founder** at `/admin/pilots`, copies it to clipboard, and shares
via Slack / email / etc. Founder clicks → lands on
`/register?pilotToken=…` → signs up → account is automatically flagged
with a 30-day pilot window. After the window expires, the bypass
naturally stops (the gates check `pilot_until > now()`), so the next
recovery / next billing cycle bills normally — no manual graduation step
needed.

---

## Goals

| # | Goal | Mechanism |
|---|------|-----------|
| 1 | Up to 10 hand-picked founders run Winback for free for 30 days | Per-customer `pilot_until` timestamp; gates in activation + perf-fee paths |
| 2 | Pilot onboarding feels normal — no separate flow, no manual setup | Single-use signup URL with `?pilotToken=…`; redeemed in the regular `POST /api/auth/register` |
| 3 | Pilot billing cuts off automatically | Gates are `pilot_until > now()`; once past, normal billing flows resume on next event |
| 4 | Founder isn't surprised when paid billing kicks in | Day-23 "pilot ending in 7 days" heads-up email |
| 5 | Operator visibility — who's pilot, days remaining, slots used | New `/admin/pilots` page |
| 6 | Track the economic value of the pilot | Audit events log `skippedAmountCents` on every bypass so we can answer "what would they have paid?" |

---

## Non-goals

- **Multi-tier or per-token configurable durations.** Every pilot is 30 days.
  If we ever want a "60-day strategic-account pilot", that's a follow-up.
- **Admin "extend pilot" UI.** v1 is a `psql UPDATE` if needed. Built for
  `<10 founders` operationally; a UI would be premature.
- **Auto-graduation email** ("welcome to paid"). The Day-23 heads-up is
  enough. We can add a "thanks for piloting, you're now on the regular plan"
  email later if we observe drop-off.
- **End-of-pilot usage summary** (recoveries delivered, $ would-have-paid).
  Nice to have, not required to ship.
- **Auto-revoking unused pilot tokens.** The 14-day token TTL handles this —
  `consumePilotToken` rejects expired tokens at lookup time, so there's no
  separate cleanup cron. The Spec 30 90-day account prune handles ghost
  accounts that never connected anyway.

---

## Detection (single SQL truth)

```sql
-- Active pilots (count toward 10-cap)
SELECT u.email, c.pilot_until,
       (c.pilot_until - now()) AS time_remaining
FROM   wb_customers c
JOIN   wb_users u ON u.id = c.user_id
WHERE  c.pilot_until > now()
ORDER BY c.pilot_until;

-- Cap calculation = active pilots + unused unexpired tokens
SELECT
  (SELECT count(*) FROM wb_customers WHERE pilot_until > now())
  +
  (SELECT count(*) FROM wb_pilot_tokens WHERE used_at IS NULL AND expires_at > now())
  AS slots_used;
```

---

## Database — migration 026

```sql
ALTER TABLE wb_customers
  ADD COLUMN IF NOT EXISTS pilot_until                  TIMESTAMP,
  ADD COLUMN IF NOT EXISTS pilot_ending_warned_at       TIMESTAMP;

CREATE TABLE IF NOT EXISTS wb_pilot_tokens (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         text NOT NULL UNIQUE,
  expires_at         timestamp NOT NULL,
  used_at            timestamp,
  used_by_user_id    uuid REFERENCES wb_users(id) ON DELETE SET NULL,
  note               text,
  created_at         timestamp NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES wb_users(id) ON DELETE SET NULL
);

-- Active-pilot lookups (10-cap, admin UI list, isCustomerOnPilot gate).
CREATE INDEX IF NOT EXISTS wb_customers_pilot_until_idx
  ON wb_customers (pilot_until)
  WHERE pilot_until IS NOT NULL;
```

Drizzle: add to [lib/schema.ts](../lib/schema.ts):
```ts
// On the customers pgTable
pilotUntil:               timestamp('pilot_until'),
pilotEndingWarnedAt:      timestamp('pilot_ending_warned_at'),

// New table
export const pilotTokens = pgTable('wb_pilot_tokens', {
  id:               uuid('id').primaryKey().defaultRandom(),
  tokenHash:        text('token_hash').notNull().unique(),
  expiresAt:        timestamp('expires_at').notNull(),
  usedAt:           timestamp('used_at'),
  usedByUserId:     uuid('used_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  note:             text('note'),
  createdAt:        timestamp('created_at').notNull().defaultNow(),
  createdByUserId:  uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
})
```

**Why on `wb_customers` and not `wb_users`?** Pilot status is a billing
concept; activation + performance-fee logic already operates on
`customerId`. Co-locating with `activatedAt`, `stripeSubscriptionId`,
`pausedAt` keeps the bypass check a single-row lookup with no JOIN.

---

## Token model

Mirrors Spec 29 (password-reset). New `src/winback/lib/pilot.ts`:

- `generateRawToken()` — 256-bit base64url (`crypto.randomBytes(32).toString('base64url')`)
- `hashToken(raw)` — sha256 hex; only the hash is stored, raw lives only in
  the URL the admin pastes
- **TTL = 14 days** on the token. Separate from the 30-day pilot duration.
  Gives the admin time to send the link and the founder time to click.
- `validatePilotToken(raw)` — read-only; returns `{ ok, tokenId } | { ok: false, reason }`
- `consumePilotToken(raw)` — atomic conditional UPDATE: returns `tokenId`
  only if `used_at IS NULL AND expires_at > now()`. Race-safe.
- `issuePilotToken({ note, createdByUserId })` — inserts a new row, returns
  `{ rawToken, expiresAt }`
- `isCustomerOnPilot(customerId)` — `SELECT 1 FROM wb_customers WHERE id = ? AND pilot_until > now()` — used by the bypass gates
- `runPilotEndingWarnings({ dryRun })` — daily-cron pass; finds customers
  whose `pilot_until` is 6-8 days away and haven't been warned

---

## Bypass gates

Two surgical insertions. Both are early-returns at the top of the existing
billing functions.

### Platform subscription (`src/winback/lib/activation.ts`)

The bypass lives in `ensureActivation` (the orchestration layer), not
inside `ensurePlatformSubscription` (the leaf Stripe call). This keeps
`ensurePlatformSubscription`'s return type clean (`{ subscriptionId: string }`)
and adds a new `ActivationState` variant rather than retrofitting a
`skipped` flag onto the `'active'` state.

After the `deliveriesExist` check, before charging pending perf fees:

```ts
if (await isCustomerOnPilot(wbCustomerId)) {
  const pilotUntil = await getPilotUntil(wbCustomerId)
  await logEvent({
    name: 'platform_billing_skipped_pilot',
    customerId: wbCustomerId,
    properties: { pilotUntil: pilotUntil?.toISOString() ?? null },
  })
  return { state: 'pilot', pilotUntil }
}
```

New `ActivationState` variant: `{ state: 'pilot'; pilotUntil: Date | null }`.

### Performance fee (`src/winback/lib/performance-fee.ts`)

At the top of `chargePerformanceFee(recoveryId)`:
```ts
const customerId = <fetch from recoveries.customerId>
if (await isCustomerOnPilot(customerId)) {
  await logEvent({
    name: 'performance_fee_skipped_pilot',
    customerId,
    properties: { recoveryId, skippedAmountCents: planMrrCents },
  })
  return { skipped: true, reason: 'pilot' }
}
```

The `skippedAmountCents` field is the would-have-charged amount. Across all
pilots, summing this over time = total comp value of the pilot program.

**Both gates are checked at billing-time, not at recovery-time.** A recovery
that happened *before* `pilot_until` was set isn't retroactively un-charged
(that'd be wrong). Only billing actions occurring while the pilot window is
open are skipped.

---

## Register flow

[app/register/page.tsx](../app/register/page.tsx):
- Read `searchParams.get('pilotToken')`
- Render a small "🚀 **Pilot invite** — onboarding for free" badge above
  the form so the founder knows the link was recognised. If no token, no
  badge.
- Pass the token through as a hidden `<input name="pilotToken">` so it
  survives the existing native-form-POST fallback (Spec 29 lesson).

[app/api/auth/register/route.ts](../app/api/auth/register/route.ts):
- Add optional `pilotToken: z.string().optional()` to the zod schema.
- **If `pilotToken` is provided, validate FIRST (read-only) before creating
  any user / customer rows.** A stale or used invite must fail the signup
  with a clear error rather than quietly creating a non-pilot account —
  silently degrading "pilot" to "regular customer" risks billing someone
  who thought the link gave them free use. (Original v1 spec said
  "registration still succeeds with no pilot flag"; corrected after the
  first round of pilot testing surfaced exactly this confusion.)
- Failure response:
  - JSON: 400 `{ error: 'This pilot invite has already been used or has expired. Ask the team for a fresh link.' }`
  - Form-encoded: 303 redirect to `/register?error=<msg>&pilotToken=<orig>`
    so the page re-renders with the badge + error inline.
  - `logEvent({ name: 'pilot_redemption_failed', userId: null, customerId: null, properties: { reason } })` — userId/customerId both null because we deliberately did NOT create the account.
- If validation passes, proceed with the existing user + customer +
  legalAcceptances inserts, then call `consumePilotToken` (atomic UPDATE).
  - On success: `UPDATE wb_customers SET pilot_until = now() + interval '30 days'`, `UPDATE wb_pilot_tokens SET used_by_user_id = <new id>`, `logEvent({ name: 'pilot_redeemed', userId, customerId, properties: { tokenId } })`.
  - **Race case** (rare): another concurrent register consumed the token between our validate and our consume. The user row already exists at this point, so we keep the registration succeeded but emit `pilot_redemption_failed_race` with userId/customerId. Operationally identical to the spec-30 admin escape hatch (psql UPDATE) — and so rare in practice that it's not worth a transaction.

---

## Admin UI

### `POST /api/admin/actions/issue-pilot`

- `requireAdmin()` gate
- Body: `{ note?: string }` (optional human-readable label, e.g. founder's name)
- Hard-cap check (atomic):
  ```ts
  const slotsUsed = activePilots + unexpiredUnusedTokens
  if (slotsUsed >= 10) return 409 { error: 'Pilot cap reached (10/10).' }
  ```
- Calls `issuePilotToken({ note, createdByUserId })`
- Returns `{ url: '${NEXT_PUBLIC_APP_URL}/register?pilotToken=<raw>', expiresAt }`
- Emits `admin_action` event with `properties: { action: 'issue_pilot', tokenId, note }`

### `GET /api/admin/pilots`

- `requireAdmin()` gate
- Returns a single payload combining redeemed pilots + outstanding tokens:
  ```ts
  {
    slotsUsed: number,
    capacity: 10,
    activePilots: [{ email, founderName, pilotUntil, daysRemaining,
                    headsUpSent, stripeConnected, redeemedAt }],
    pendingTokens: [{ tokenId, note, expiresAt, createdAt, createdByEmail }],
  }
  ```
  `stripeConnected` derives from `wb_customers.stripe_access_token IS NOT NULL` —
  same expression the `/api/admin/customers` route uses. Operationally
  important: a pilot who hasn't connected Stripe has produced zero value
  yet; the admin page should make that obvious at a glance.

### `/admin/pilots` page

Server component (gate via `requireAdmin`) wrapping a client component:
- "Issue pilot invite" button + optional note text input
- On click → POST → modal showing the URL with copy-to-clipboard
- Table of active pilots: `email · days remaining · redeemed-or-pending`
- Cap indicator: `X / 10 slots used`
- Future: "revoke" button → marks token used + nulls `pilot_until`. Out of
  scope for v1; reserve the column behaviour by allowing it to land later
  without migration.

Add link to `/admin/pilots` in the existing admin nav.

---

## Day-23 heads-up email

`src/winback/lib/email.ts`, after the existing dormant-warning email:

```ts
export async function sendPilotEndingSoonEmail(opts: {
  to: string
  founderName: string | null
  endsOn: Date
}): Promise<void>
```

From `Winback <support@winbackflow.co>` — replies welcomed, same as the
Spec 30 nudge / warning emails. Plain text:

```
Hi {founderName ?? 'there'},

Quick heads-up: your Winback pilot ends on {endsOn}. After that, normal
billing kicks in — $99/mo platform fee plus 1× MRR per win-back recovery
(refundable for 14 days).

Nothing for you to do right now. We'll email a usage summary at the end
of the pilot. If you want to discuss pricing or extend the pilot, just
hit reply.

Thanks for kicking the tires.

— Winback
```

`runPilotEndingWarnings({ dryRun })` lives in `src/winback/lib/pilot.ts`
and is wired into [`/api/cron/onboarding-followup`](../app/api/cron/onboarding-followup/route.ts)
as a 4th pass. Eligibility:

```ts
where(and(
  isNotNull(customers.pilotUntil),
  isNull(customers.pilotEndingWarnedAt),
  sql`${customers.pilotUntil} BETWEEN now() + interval '6 days' AND now() + interval '8 days'`,
)).limit(50)
```

(7-day target with ±1 day window so a missed cron tick doesn't permanently
skip a pilot. After send: `UPDATE wb_customers SET pilot_ending_warned_at = now()`.)

The Spec 30 cron route already handles three founder-lifecycle passes;
adding a fourth keeps cron count low. Same `?dryRun=1`, same auth, same
per-row try/catch.

---

## Dashboard banner

Existing `app/dashboard/dashboard-client.tsx` shows a "your $99/mo
subscription will start when…" banner that's wrong for pilots. Replace it
when `customer.pilotUntil > now()` with:

> 🚀 **Pilot — until {dateFormat(pilotUntil)}** ({daysRemaining} days
> remaining). No charges during the pilot.

Below day-23, append: *"Pilot ends on X — billing details in your inbox."*

The dashboard server component already loads `customer` — just thread
`pilotUntil` through to the client.

---

## Tests (~25 new)

Pattern: heavy `vi.hoisted` mocks of `@/lib/db`, `@/lib/schema`,
`drizzle-orm` (mirrors Spec 29 password-reset and Spec 30 cron tests).

- **`pilot-token.test.ts`** (~8): generate, hash, validate (not-found / used
  / expired / valid), consume (atomic, returns null on race), `issuePilotToken`
  enforces 14-day TTL, the cap-counting helper
- **`pilot-bypass.test.ts`** (~6): `ensurePlatformSubscription` returns early
  when pilot active and emits `platform_billing_skipped_pilot`;
  `chargePerformanceFee` returns early when pilot active and logs
  `skippedAmountCents`; both proceed normally when `pilot_until` is past
- **`pilot-cron.test.ts`** (~5): heads-up sends in the 6-8 day window;
  idempotent via `pilot_ending_warned_at`; respects `dryRun`; skips
  customers whose `pilot_until` is null or already past
- **`admin-issue-pilot.test.ts`** (~4): admin gate (401/403); cap
  enforcement at 10 (rejects 11th); generates URL containing token;
  emits `admin_action` event

Update `events.test.ts` whitelist if it filters names: add
`pilot_redeemed`, `pilot_redemption_failed`, `platform_billing_skipped_pilot`,
`performance_fee_skipped_pilot`, `pilot_ending_soon_sent`.

---

## Verification before merge

Per CLAUDE.md merge discipline:

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green
- [ ] Migration 026 applied to Neon (show SQL, wait for "yes")
- [ ] **End-to-end manual click-through:**
  - Sign in as admin → `/admin/pilots` → "Issue pilot invite" → copy URL
  - Open URL in incognito → register a fresh test account
  - `psql` confirm: `wb_customers.pilot_until` is ~30 days out;
    `wb_events` has `pilot_redeemed`
  - Connect Stripe (test mode), simulate a win-back via the dev test harness
  - **Confirm zero Stripe charges:** no platform subscription on
    Winback's test Stripe account; no performance-fee invoice item;
    `wb_events` has `platform_billing_skipped_pilot` AND
    `performance_fee_skipped_pilot` with `skippedAmountCents` set
  - Backdate `pilot_until` to `now() - 1 day` in psql → trigger another
    win-back → confirm normal billing resumes (subscription created, fee
    charged)
  - Backdate `pilot_until` to `now() + 7 days`, run cron with `?dryRun=1`
    → confirm Day-23 heads-up is eligible
- [ ] PR opens with explicit migration callout
- [ ] Human says "merge"

---

## Edge cases handled

1. **Founder clicks an expired or already-used pilot link** — registration
   still succeeds, just no pilot flag is set. Bad UX would be hard-failing.
   Logged as `pilot_redemption_failed` so ops can manually flag in psql if
   the founder was supposed to be a pilot.
2. **Pilot redeemed mid-flight** — `isCustomerOnPilot` is checked at
   billing-time, not recovery-time. A recovery delivered *before*
   `pilot_until` was set isn't retroactively un-charged; only billing
   actions occurring during the window are skipped.
3. **Internal accounts** (`users.is_admin = true`) — already excluded from
   Spec 30 cron passes. Same exclusion in `runPilotEndingWarnings`.
4. **Race in cap-check** — two admins simultaneously click "Issue pilot
   invite" at slot 9. Both see count = 9, both succeed → 11 active. Two
   options: serialisable transaction around the count + insert, OR accept
   the race (it's two humans clicking at the same moment in private
   admin — if the 11th-pilot ever fires, fine). **Recommend: accept the
   race**, document it. We can add the transaction later if it ever bites.
5. **Pilot graduates mid-recovery** — `pilot_until` passes while a recovery
   webhook is being processed. The bypass check uses `pilot_until > now()`
   evaluated at the moment of the gate; if it just expired, normal billing
   fires. Correct behaviour.
6. **10 cap counts unredeemed tokens too** — to prevent issuing 50 tokens
   "in case some don't redeem" and ending up with 50 active pilots. Each
   outstanding pending invite holds a slot until it expires (14 days) or
   is redeemed.

---

## Out of scope (future)

- Pilot extension flow (admin manually pushes `pilot_until` forward)
- Per-token configurable durations
- End-of-pilot usage summary email with $ "would have paid"
- Revoke-pilot button
- Pilot graduation email ("welcome to paid")

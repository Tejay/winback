# Spec 56 — Connect account uniqueness

## Context

During Tier 1 billing testing on 2026-05-11, we triggered a real cancel
webhook on the Connect account `acct_1TL2kEDFBmovd2Ws` and watched it
deliver into the **wrong** Winback customer row. Investigation showed
two `wb_customers` rows both had `stripe_account_id = acct_1TL2kE…`:

- `tejaasvi@gmail.com` → `customerId=609356c6-…`
- `tejaasvi+Verify1@gmail.com` → `customerId=29d3ff3c-…`

The webhook handlers (`processChurn`, `processRecovery`,
`processPaymentFailed`, `processPaymentSucceeded`, etc. in
`app/api/stripe/webhook/route.ts`) all do:

```ts
.where(eq(customers.stripeAccountId, accountId))
.limit(1)
```

…so when multiple rows match, whichever Postgres returns first wins
(no `ORDER BY`, no tie-break). Subsequent merchants who connect an
already-linked Stripe account silently start stealing webhook events
from the original owner.

This blocked Tier 1.1 from completing and — more importantly —
represents a **multi-tenant data integrity hole**. In prod, two
founders OAuthing into the same Stripe account would corrupt each
other's dashboards. The fix is to make `stripe_account_id` unique at
the DB level and reject re-linking at OAuth time.

Per CLAUDE.md spec-first rule, this doc is the contract. Implementation
follows on a branch only after human "ok".

## Goals

- DB-level guarantee that one Stripe Connect account links to at most
  one Winback customer row.
- OAuth callback rejects re-linking with a clear UX error when the
  target Stripe account is already owned by another Winback workspace.
- Backfill plan for the one known existing duplicate
  (`tejaasvi+Verify1` ↔ `acct_1TL2kEDFBmovd2Ws`).
- No change to legitimate workflows: same user re-OAuthing the same
  Stripe account (idempotent), same user switching to a different
  Stripe account (Spec 49 — already handled), and a brand-new user
  connecting a Stripe account that no one has ever connected before.

## Non-goals

- **Auto-migration of subscribers from one customer to another.** If
  two workspaces share a Stripe account today (the Verify1 case), we
  null out the non-canonical row's link rather than try to "merge" or
  reassign churned-subscriber rows. The non-canonical merchant
  re-OAuths into a fresh Stripe account when they want to use Winback
  again.
- **Retroactive splitting of historic `wb_churned_subscribers` /
  `wb_recoveries` rows** that were misattributed before this fix. The
  test data on `tejaasvi+Verify1@gmail.com` (42 subscribers) stays
  parked on that row; tejaasvi's clean baseline starts after the
  reset script runs.
- **Webhook handler de-duplication / tie-break logic.** With the
  UNIQUE constraint, `.limit(1)` is correct by construction; no
  handler changes needed.

## Schema

New migration `src/winback/migrations/036_unique_stripe_account_id.sql`:

```sql
-- Spec 56 — One Stripe Connect account links to at most one Winback
-- customer. Partial index allows NULL (un-onboarded) rows freely.
CREATE UNIQUE INDEX IF NOT EXISTS customers_stripe_account_id_unique
  ON wb_customers (stripe_account_id)
  WHERE stripe_account_id IS NOT NULL;

COMMENT ON INDEX customers_stripe_account_id_unique IS
  'Spec 56 — enforces 1:1 between Connect account and Winback customer. '
  'OAuth callback rejects re-link attempts. Backfill: NULL out duplicate '
  'non-canonical rows before applying migration.';
```

**Migration ordering — important:** the migration MUST be preceded by
the backfill (see below). Otherwise the `CREATE UNIQUE INDEX` fails
with a duplicate-key error and aborts the deploy.

Drizzle schema (`lib/schema.ts`):

```ts
// Inside the `customers` table definition, add a uniqueIndex declaration:
(table) => ({
  stripeAccountIdUnique: uniqueIndex('customers_stripe_account_id_unique')
    .on(table.stripeAccountId)
    .where(sql`${table.stripeAccountId} IS NOT NULL`),
})
```

## Code paths touched

| File | Change |
|---|---|
| `src/winback/migrations/036_unique_stripe_account_id.sql` | NEW — partial UNIQUE index |
| `lib/schema.ts` | Add `uniqueIndex` declaration on customers table |
| `app/api/stripe/callback/route.ts` | After token exchange, before UPDATE: check whether `newAccountId` is already linked to a DIFFERENT customer; if so, log `oauth_error{errorType: 'account_already_linked'}` + redirect to `/onboarding/stripe?error=account_already_linked` |
| `app/onboarding/stripe/page.tsx` | Handle the new `error=account_already_linked` query string with friendly copy: "This Stripe account is already connected to another Winback workspace. Connect a different account, or contact support if this is unexpected." |
| `src/winback/__tests__/oauth-callback-uniqueness.test.ts` | NEW — vitest covering: (a) first-connect on a fresh Stripe account succeeds, (b) same user re-OAuths same Stripe account succeeds (idempotent), (c) different user OAuths a Stripe account already linked elsewhere → redirected with `account_already_linked`, (d) account-change case from Spec 49 still works |

OAuth callback diff (logical, not literal):

```ts
// After `tokenData = await tokenRes.json()`, before the UPDATE block:

const [conflict] = await db
  .select({ id: customers.id, userId: customers.userId })
  .from(customers)
  .where(and(
    eq(customers.stripeAccountId, newAccountId),
    ne(customers.id, state),  // not THIS customer
  ))
  .limit(1)

if (conflict) {
  await logEvent({
    name: 'oauth_error',
    customerId: customer.id,
    userId: customer.userId,
    properties: {
      errorType: 'account_already_linked',
      newAccountId,
      conflictingCustomerId: conflict.id,
    },
  })
  return NextResponse.redirect(`${baseUrl()}/onboarding/stripe?error=account_already_linked`)
}
```

## Edge cases handled

1. **Same user, same Stripe account re-OAuth (idempotent).** Conflict
   check excludes the current customer (`ne(customers.id, state)`), so
   re-OAuth of the same row is a no-op. Maps to the most common
   support-driven retry.
2. **Same user, different Stripe account (Spec 49 path).** Untouched.
   Conflict check only fires if the *new* account is linked elsewhere;
   if it's free, the existing Spec 49 code-path runs.
3. **Different user, same Stripe account (the bug we're fixing).**
   Conflict check fires → redirect with `account_already_linked`. No
   DB write happens, so the original linkage is preserved intact.
4. **A user disconnects, then someone else connects the same Stripe
   account.** Disconnect (if/when we ship one) would NULL out
   `stripeAccountId` on the original row, freeing it up. Out of scope
   for this spec, but the UNIQUE-partial-index design accommodates it.
5. **Race between two OAuths landing simultaneously.** The DB UNIQUE
   index is the source of truth: the second `UPDATE` errors with
   `duplicate key value violates unique constraint
   "customers_stripe_account_id_unique"`. The callback catches and
   redirects with `account_already_linked` (same UX as the explicit
   pre-check). The explicit pre-check is a UX optimization, not the
   integrity guarantee — the index is.

## Backfill plan

Before applying migration 036, run a one-shot script
`scripts/spec-56-backfill-duplicates.ts` (committed alongside the
spec, but not run automatically by deploy):

```ts
// Detect duplicate sets and propose a canonical owner.
// --dryRun by default; pass --apply to actually mutate.
//
// Canonical owner = the row with the most recent `updatedAt` (proxy
// for "most actively used"). For ties, prefer the row with the most
// wb_churned_subscribers attached.
```

Expected output today:

```
Duplicate set: acct_1TL2kEDFBmovd2Ws
  KEEP:  tejaasvi@gmail.com  customerId=609356c6-…  (most recent activity)
  CLEAR: tejaasvi+Verify1@gmail.com  customerId=29d3ff3c-…
    will NULL: stripeAccountId, stripeAccessToken, onboardingComplete
    NOTE: 42 churned_subscribers will remain orphaned on this row
```

Run order on deploy day:
1. `npx tsx scripts/spec-56-backfill-duplicates.ts --dryRun` (review)
2. `npx tsx scripts/spec-56-backfill-duplicates.ts --apply`
3. `psql $DATABASE_URL -f src/winback/migrations/036_unique_stripe_account_id.sql`
4. Verify: `SELECT stripe_account_id, COUNT(*) FROM wb_customers
   WHERE stripe_account_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;`
   → returns zero rows.
5. Merge the PR with the OAuth callback + schema code changes.

Apply against dev branch first, verify, then against prod main.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — including the new
      `oauth-callback-uniqueness.test.ts` cases (4 assertions above)
- [ ] Dev DB shows zero duplicate sets after backfill
- [ ] Migration 036 applied to dev, `\d wb_customers` shows the new
      partial unique index
- [ ] **Manual click-through (dev):** Log in as `tejaasvi@gmail.com`
      (already linked to `acct_1TL2kE…`). Log out. Sign up a brand-new
      test founder. Try to OAuth into `acct_1TL2kE…`. Expect: redirect
      to `/onboarding/stripe?error=account_already_linked` with the
      friendly copy.
- [ ] **Manual click-through (dev):** Re-run Tier 1.1
      (`scripts/billing-test-tier1-real-webhook.ts`) on `tejaasvi`.
      Expect: webhook routes to `customerId=609356c6-…`, not to
      `+Verify1`'s row.
- [ ] **Prod-safety:** before applying to prod, confirm zero duplicate
      sets in prod via the read-only admin DB connection. If any
      exist, run the backfill in `--dryRun` against prod first and
      hand-verify the proposed canonical owners.
- [ ] Spec doc lives at `specs/56-connect-account-uniqueness.md` on
      main; PR description references "Spec 56".

## Why this matters

Without this, prod is one customer-support typo away from a multi-tenant
data leak — two paying merchants seeing each other's subscriber lists.
The current failure mode is silent (no error, just wrong row gets
written), which is the worst kind of bug to ship into a launch week.

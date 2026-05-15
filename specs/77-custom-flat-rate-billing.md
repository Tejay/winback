# Spec 77 — Per-customer custom flat-rate billing

## Context

The standard Winback pricing model (per `CLAUDE.md`):
- **$99/mo platform fee** — Stripe Subscription on Winback's account
- **1× MRR performance fee per win-back recovery** — added as Stripe invoice
  item against the platform subscription, refundable in 14 days

For most merchants this is right. But some merchants negotiate a **flat
monthly all-inclusive rate** — e.g., $299/mo or $399/mo — and explicitly
don't want performance fees on top. The deal is "fixed cost, you handle
everything." Reasonable position for a merchant who values predictability
over a usage-based model.

Today the only way to honor this deal is by manual Stripe Dashboard
edits (custom Price, swap the subscription, then comment out the perf-fee
code path for that customer). That's brittle and unscriptable.

This spec adds **first-class support for per-customer flat-rate billing**,
assignable from the admin UI. The implementation mirrors the existing
pilot bypass (`wb_customers.pilot_until` + `isCustomerOnPilot()` gate
in `src/winback/lib/performance-fee.ts:138`) — same shape, different
column.

## Goals

1. **DB column** — `wb_customers.custom_monthly_cents INTEGER NULL`.
   NULL = standard billing ($99 + perf). Non-NULL = custom flat rate
   in cents (e.g., 29900 for $299/mo), perf fees disabled.
2. **Performance fee gate** — when `custom_monthly_cents IS NOT NULL`,
   skip perf-fee creation (analogous to the pilot bypass).
3. **Platform subscription Price** — when creating the Stripe
   Subscription for a flat-rate customer, use a custom one-off Price
   with `unit_amount = custom_monthly_cents` instead of the standard
   `$99` Price.
4. **Admin UI** — `/admin/customers/[id]` gets a "Custom pricing"
   section. Admin can set the cents, save, and see the current state.
   Reverting (clearing the column) restores standard billing.
5. **Audit trail** — emit `flat_rate_assigned` and `flat_rate_cleared`
   events with `{customerId, cents, adminEmail}`.

## Non-goals

- **Per-subscriber pricing tiers** ("$299 for some subs, $399 for
  others within the same merchant"). Today's pricing is per-customer;
  this spec preserves that.
- **Per-recovery flat fee** (e.g., "$10 per win-back, no monthly"). Not
  what the merchant is asking for.
- **Automated negotiation flow / quote page** — admin is the negotiator;
  this spec just gives admin the lever.
- **Yearly billing / multi-month commitments.** Stripe Subscriptions
  with monthly interval only. Annual is a future spec if anyone asks.
- **Merchant-facing UI to see/change their plan.** They see the right
  amount on their Stripe-hosted invoices and the in-app billing page;
  no separate "I'm on a custom plan" badge in v1.
- **Migration of existing pilot logic.** Pilot stays as-is — it's a
  separate concept (time-limited free comp, not a price override).

## Why the gate, not denormalization

Could instead persist `is_flat_rate boolean` + `flat_rate_cents` and
duplicate elsewhere. Or just store `custom_monthly_cents`. We're storing
just the cents column because:
- `NULL = standard, non-NULL = custom` is unambiguous
- One source of truth, no boolean-and-cents-must-agree invariant to maintain
- Cheap to migrate later if we add tiers

## Schema

**Migration 044** — `migrations/044_custom_monthly_cents.sql`:

```sql
ALTER TABLE wb_customers
  ADD COLUMN custom_monthly_cents INTEGER;

COMMENT ON COLUMN wb_customers.custom_monthly_cents IS
  'Spec 77 — Custom flat-rate monthly fee in cents. NULL = standard $99/mo + perf fees. Non-NULL = flat rate (perf fees disabled, platform sub uses a one-off Stripe Price at this amount).';
```

No index needed — the column is read on per-customer billing operations
(already keyed by customer.id), never scanned cross-customer.

## Behavioral changes

### 1. Performance fee bypass

`src/winback/lib/performance-fee.ts` — extend the existing skip section
right after the pilot check (line 138):

```ts
if (await isCustomerOnPilot(rec.customerId)) {
  // ... existing pilot bypass
  return { ..., skipped: 'pilot' }
}

// Spec 77 — custom flat-rate bypass. The merchant is on a negotiated
// monthly deal; their fee is collected via the platform Subscription
// at the custom amount, not per-recovery.
const flatRateCents = await getCustomMonthlyCents(rec.customerId)
if (flatRateCents !== null) {
  await logEvent({
    name: 'performance_fee_skipped_flat_rate',
    customerId: rec.customerId,
    properties: {
      recoveryId,
      skippedAmountCents: rec.planMrrCents,
      customMonthlyCents: flatRateCents,
    },
  })
  return { invoiceItemId: null, amountCents: rec.planMrrCents, alreadyCharged: false, skipped: 'flat_rate' }
}
```

The `skipped` return field gets a new variant `'flat_rate'` alongside the
existing `'pilot' | 'race'`.

### 2. Platform subscription Price selection

`src/winback/lib/subscription.ts` — `getOrCreatePlatformPriceId()` becomes
customer-aware:

```ts
async function getPlatformPriceIdForCustomer(
  stripe: Stripe,
  customerId: string,
): Promise<string> {
  const flatRateCents = await getCustomMonthlyCents(customerId)
  if (flatRateCents !== null) {
    // One-off custom Price for this merchant. Standard Stripe pattern
    // for negotiated deals. We tag it with metadata so it's discoverable
    // in the dashboard.
    const product = await stripe.products.create({
      name: `Winback Custom Plan (${customerId.slice(0, 8)})`,
      metadata: { winback_role: 'custom_flat_rate', customer_id: customerId },
    })
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: flatRateCents,
      currency: PLATFORM_FEE_CURRENCY,
      recurring: { interval: 'month' },
      metadata: { winback_role: 'custom_flat_rate', customer_id: customerId },
    })
    return price.id
  }
  return getOrCreatePlatformPriceId(stripe)  // existing standard $99 path
}
```

Callers of `getOrCreatePlatformPriceId` get updated to pass `customerId`.

### 3. Switching an existing customer onto flat rate

When admin assigns flat-rate to a customer who already has an active
`$99/mo` subscription, we **cancel the old subscription at period-end
and create a new one at the custom Price**. Rationale:
- Cleaner invoice trail (no proration confusion)
- Merchant pays remainder of current $99 cycle, then transitions
- The new sub starts at next billing cycle
- Simpler Stripe API calls than `subscription.items.update()` + proration

This logic lives in a new helper `switchCustomerToFlatRate(customerId,
cents)` in `subscription.ts`. Inverse helper `revertCustomerToStandardRate(customerId)`
does the reverse: cancel custom sub at period end, recreate standard sub
at $99 at the next cycle.

### 4. In-flight perf fees

Perf fees already in flight (recoveries with `perfFeeStripeItemId` set
on their `wb_recoveries` row) **still bill** under the old terms — those
have already been added as invoice items on the customer's current
invoice, and that invoice will finalize at period-end as scheduled.

Recoveries whose perf fee hasn't been created yet (`perfFeeStripeItemId
IS NULL`) at the moment of flat-rate assignment will hit the new bypass
gate the next time the activation flow tries to ensure them. Net effect:
**the deal is forward-looking** — the merchant pays out the current
billing period at the old terms (including any queued perf fees) and
transitions cleanly at the next renewal.

This is the simplest, most predictable behavior. Admin who needs an
immediate cut-over can manually `subscription.cancel({ invoice_now: false })`
in the Stripe dashboard.

### 5. Refunds

The 14-day perf-fee refund window doesn't apply to flat-rate customers —
there's nothing to refund per-recovery. Standard Stripe subscription
refunds still apply for the monthly fee if a merchant disputes a charge.

## Admin UI

`/admin/customers/[id]` — new "Custom pricing" section near the existing
billing info.

```
─── Custom pricing ───────────────────────────
Current state: Standard ($99/mo + 1× MRR perf fee per recovery)

[ Assign flat rate ]
```

After clicking "Assign flat rate":

```
─── Custom pricing ───────────────────────────
Current state: Standard ($99/mo + 1× MRR perf fee per recovery)

Monthly amount:  $ [29900 / 100] = $299.00 / month
                 [ Save & switch ]  [ Cancel ]
```

After saving:

```
─── Custom pricing ───────────────────────────
Current state: Custom flat rate — $299.00 / month (assigned Apr 14 by admin@winback.co)
               Performance fees disabled.

[ Revert to standard ]
```

Inline confirmation modal for "Save & switch":
- Warns that the existing $99 sub will cancel at period-end
- Warns that any queued perf fees on the current invoice will still bill
- Requires admin to type "SWITCH" to confirm (matches the existing
  destructive-action pattern in admin)

Similar pattern for "Revert to standard."

## API contract

**New: `POST /api/admin/customers/[id]/custom-rate`**

```ts
// Request
{ cents: number, confirm: 'SWITCH' }

// Response
{ ok: true, customer: { id, customMonthlyCents, ... } }
```

Validates `cents` is a positive integer ≤ 999999 ($9,999.99 ceiling — sanity).
Validates `confirm === 'SWITCH'`. Sets the column, fires Stripe subscription
swap, logs `flat_rate_assigned` event.

**New: `DELETE /api/admin/customers/[id]/custom-rate`**

Reverts to standard. Same body shape: `{ confirm: 'REVERT' }`.

Both endpoints are admin-only (`requireAdmin()`), wrapped in a single try
so partial Stripe failures get logged + returned as 500.

## Code paths touched

### Schema + migration
- **`lib/schema.ts`** — add `customMonthlyCents: integer('custom_monthly_cents')` to `customers` table
- **`src/winback/migrations/044_custom_monthly_cents.sql`** — new

### Lib
- **New: `src/winback/lib/flat-rate.ts`** — `getCustomMonthlyCents(customerId)` reader function (mirrors `getPilotUntil`)
- **`src/winback/lib/performance-fee.ts`** — add flat-rate bypass after pilot bypass; expand `skipped` union to `'pilot' | 'race' | 'flat_rate'`
- **`src/winback/lib/subscription.ts`** — `getOrCreatePlatformPriceId` becomes customer-aware; new `switchCustomerToFlatRate` + `revertCustomerToStandardRate` helpers

### Admin API
- **New: `app/api/admin/customers/[id]/custom-rate/route.ts`** — POST + DELETE

### Admin UI
- **`app/admin/customers/[id]/customer-detail-client.tsx`** — new "Custom pricing" section

### Tests
- **New: `src/winback/__tests__/flat-rate-bypass.test.ts`** — verifies `performance-fee.ts` bypasses correctly when `custom_monthly_cents` set
- **New: `src/winback/__tests__/admin-custom-rate.test.ts`** — admin endpoint tests (auth, validation, happy path, revert)
- **Update: existing perf-fee tests** — confirm pilot bypass still works alongside the new flat-rate bypass

## Edge cases

- **Customer is on pilot AND flat-rate assigned simultaneously** — pilot
  wins (it's a free comp; the merchant shouldn't pay anything during
  pilot). After pilot expires, flat-rate kicks in normally. Order of
  checks in `performance-fee.ts`: pilot first, flat-rate second.
- **Admin tries to assign $0 flat rate** — reject with 400. Use the
  pilot mechanism for free comps instead.
- **Admin tries to assign flat rate > $9,999** — reject as sanity check.
  Custom deals above that need a human at Stripe.
- **Concurrent admin requests** (two admins assign different rates at
  once) — last write wins on the DB column. Both Stripe subscription
  swaps would happen serially per Stripe's idempotency; the second
  cancels the first's new sub and creates another. Acceptable for
  rare admin races; log both events for the audit trail.
- **Customer has no Stripe Customer yet** (signed up, never connected)
  — assignment still works (sets the column), but no subscription
  swap fires. When they later complete Stripe Connect, the platform
  sub gets created at the custom Price via the customer-aware
  `getOrCreatePlatformPriceId`.
- **Reverting a customer who was originally on a custom rate from
  signup** — same path: cancel custom sub at period-end, recreate
  standard $99 sub.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green
- [ ] Migration 044 applies on dev and prod
- [ ] Dev: pick a connected customer, assign flat-rate $299
- [ ] Stripe dashboard: new Product "Winback Custom Plan (xxxx)" + Price
      with `unit_amount=29900` exists
- [ ] Customer's old `$99` Subscription is set to cancel at period end
- [ ] New custom Subscription created on the customer
- [ ] Simulate a win-back recovery: `performance_fee_skipped_flat_rate`
      event fires, no Stripe invoice item created
- [ ] Revert: original $99 sub flow resumes
- [ ] Audit trail: `flat_rate_assigned` and `flat_rate_cleared` events
      with admin email in properties
- [ ] Confirm modal requires "SWITCH" / "REVERT" string typed
- [ ] Non-admin user gets 401/403 on the endpoint
- [ ] Customer with existing pilot still gets pilot bypass first

## Phasing

Single PR (`feat/spec-77-custom-flat-rate-billing`).

**Deployment order on prod:**
1. Apply migration 044 to prod Neon **before** merging the code PR (same
   pattern as Spec 72 migration 042). The new column is nullable so the
   running code is unaffected by its presence.
2. Merge code PR → Vercel deploys.
3. Admin can now assign flat rates from the UI.

## Rollback

`git revert` the merge. The migration column stays — it's nullable, no
data risk. Any customers who were assigned a flat rate continue to bill
via the custom Price on their Stripe subscription (Stripe-side state
unaffected). Re-applying the code revives the admin UI; admin can revert
those customers manually.

If a full DB-level rollback is needed: `ALTER TABLE wb_customers DROP
COLUMN custom_monthly_cents` — irreversible drop, only do if nobody has
been on a flat rate.

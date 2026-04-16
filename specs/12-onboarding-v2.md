# Spec 12 — Onboarding v2 (Single-step + Historical Backfill)

**Phase:** Next
**Depends on:** Spec 03 (existing onboarding), Spec 04 (Stripe OAuth, classifier, email pipeline)
**Replaces:** Spec 03 (3-step onboarding)

---

## Summary

The current onboarding is three steps: Connect Stripe, Paste Changelog,
Review First Email. This is too much friction. Steps 2 and 3 add no
immediate value — the changelog can be added later from the dashboard,
and the email review is a rubber-stamp of a fake template that
contradicts the "every email is unique" promise.

New onboarding: **Connect Stripe and land on the dashboard.** That's it.

To deliver an instant aha moment, we backfill the user's historical
cancellations from Stripe the moment they connect. The AI classifier
reviews each one and decides whether to send a win-back email — or stay
silent. This gives the fastest possible path to a first recovery.

---

## What changes

### Removed

| File | Reason |
|------|--------|
| `app/onboarding/changelog/page.tsx` | Changelog moves to dashboard (button already exists) |
| `app/onboarding/review/page.tsx` | Fake email preview, adds friction, contradicts product promise |
| `components/step-progress.tsx` | No steps to show with single-screen onboarding |

### Modified

| File | Change |
|------|--------|
| `app/onboarding/stripe/page.tsx` | Remove step progress, step badge says nothing about "of 3". After connect, redirect straight to dashboard |
| `app/api/stripe/callback/route.ts` | After OAuth, set `onboardingComplete = true`, trigger backfill job, redirect to `/dashboard` |
| `app/dashboard/page.tsx` | Remove redirect to `/onboarding/changelog`. Only redirect to `/onboarding/stripe` if no Stripe token |
| `app/dashboard/dashboard-client.tsx` | Add backfill banner component |
| `app/api/stats/route.ts` | Include `backfillTotal` and `backfillProcessed` counts |

### New

| File | Purpose |
|------|---------|
| `src/winback/lib/backfill.ts` | Pull cancelled subscriptions from Stripe, insert into DB, trigger AI classification |
| `app/api/backfill/status/route.ts` | Poll endpoint for backfill progress |

---

## Onboarding flow (new)

```
User signs up
  → /onboarding/stripe
    → Click "Connect Stripe"
      → Stripe OAuth consent screen
        → /api/stripe/callback
          → Save tokens
          → Set onboardingComplete = true
          → Start backfill (background)
          → Redirect to /dashboard
            → Dashboard shows backfill banner + data appearing in real time
```

---

## Onboarding page — `/onboarding/stripe`

Remove step progress bar. Simplify to:

```
min-h-screen bg-[#f5f5f5]

Header: Logo (top-left), py-5 px-6

Body: max-w-2xl mx-auto px-4 pb-12
  White card (rounded-2xl p-8):

    Heading:    "Connect your Stripe account."
    Subtitle:   "Winback reads your cancellation history and starts
                 recovering customers automatically."

    Stripe integration card (same as current)

    Trust points:
      ✓  Read-only access to subscriptions and customers
      ✓  Detects cancellations automatically via webhooks
      ✓  Disconnect any time from Settings

    Single CTA button: "Connect Stripe →" (primary dark, full width)
```

No "Next" button, no "Step 1 of 3", no back button. One action.

---

## Stripe callback changes — `/api/stripe/callback`

After saving OAuth tokens (existing logic), add:

```typescript
// Set onboarding complete — no more steps
await db.update(customers)
  .set({ onboardingComplete: true })
  .where(eq(customers.id, customerId))

// Start backfill in background
// Fire-and-forget to /api/backfill/start with internal auth
await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/backfill/start`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.CRON_SECRET}`,
  },
  body: JSON.stringify({ customerId }),
})

// Redirect to dashboard immediately — don't wait for backfill
redirect('/dashboard')
```

---

## Historical backfill — `src/winback/lib/backfill.ts`

### `backfillCancellations(customerId: string)`

1. Load customer record, decrypt Stripe access token
2. Create Stripe client with the connected account's token
3. Paginate through all cancelled subscriptions:
   ```typescript
   const subs = await stripe.subscriptions.list({
     status: 'canceled',
     limit: 100,
     expand: ['data.customer'],
   })
   ```
4. For each cancelled subscription:
   - **Idempotency check:** skip if `(customerId, stripeCustomerId)` pair
     already exists in `churned_subscribers`
   - Extract signals using existing `extractSignals()` from `stripe.ts`
   - Insert into `churned_subscribers` with `source: 'backfill'` (new
     column) and `status: 'pending'`
   - Update `customers.backfill_total` count
5. After all subscriptions are inserted, process each through the AI
   classifier (existing `classifySubscriber()`)
6. The classifier receives `canceled_at` as part of the signals — it
   decides whether to email or skip based on:
   - How long ago they cancelled
   - The cancellation reason
   - Whether the changelog contains relevant fixes
   - Signal strength
7. For each classified subscriber:
   - If AI says **send**: trigger email via existing pipeline, set
     `status: 'contacted'`
   - If AI says **silence/skip**: set `status: 'skipped'`
   - Update `customers.backfill_processed` count

### New column: `source` on `churned_subscribers`

```sql
ALTER TABLE wb_churned_subscribers
  ADD COLUMN source TEXT NOT NULL DEFAULT 'webhook';
```

Values: `'webhook'` (real-time from Stripe webhook) or `'backfill'`
(historical import on connect).

### New status: `skipped`

Add `'skipped'` to the status enum for churned subscribers. Means "AI
reviewed this cancellation and decided not to reach out." Displayed on
dashboard but doesn't trigger email.

Update `StatusBadge` component:
```
Skipped: bg-slate-50 text-slate-400 border border-slate-200 — icon: –
```

### New columns on `customers` for backfill progress

```sql
ALTER TABLE wb_customers
  ADD COLUMN backfill_total INTEGER DEFAULT 0,
  ADD COLUMN backfill_processed INTEGER DEFAULT 0,
  ADD COLUMN backfill_started_at TIMESTAMPTZ,
  ADD COLUMN backfill_completed_at TIMESTAMPTZ;
```

---

## Backfill API routes

### `POST /api/backfill/start`

- Auth: `Authorization: Bearer {CRON_SECRET}` (internal only)
- Body: `{ customerId: string }`
- Calls `backfillCancellations(customerId)`
- Returns `{ success: true }` when complete

### `GET /api/backfill/status`

- Auth: session (normal user auth)
- Returns:
  ```json
  {
    "total": 47,
    "processed": 23,
    "complete": false,
    "startedAt": "2026-04-16T03:00:00Z"
  }
  ```
- Dashboard polls this every 3 seconds while backfill is running

---

## Dashboard banner

When backfill is in progress or just completed, show a banner above the
stat cards:

### While processing:

```
bg-white border border-slate-200 rounded-2xl p-5 mb-6

Icon: spinning loader (animate-spin)

"Reviewing your cancellation history..."
"Found {total} cancelled subscribers so far. Winback is reviewing each
 one — we'll only reach out where it makes sense."

Progress bar: {processed}/{total} — thin bar, blue fill
```

### When complete:

```
bg-white border border-slate-200 rounded-2xl p-5 mb-6

Icon: CheckCircle (green)

"We found {total} cancelled subscribers — £{lostMrr}/mo in lost revenue."
"Winback contacted {contacted} where a recovery looked possible.
 {skipped} were too old or unlikely to convert.
 New cancellations will be recovered automatically from here."

Dismiss button (X) — stores dismissal in localStorage
```

The `lostMrr` figure is the sum of `mrr_cents` for all backfilled
subscribers. This is the aha number.

---

## Classifier changes for backfill

The existing `classifySubscriber()` in `src/winback/lib/classifier.ts`
receives `SubscriberSignals` which includes `cancelledAt`. The AI prompt
needs to account for age:

Add to the system prompt:
```
The subscriber cancelled {daysSinceCancellation} days ago. Factor this
into your decision:
- Recent cancellations (< 14 days): treat as fresh — standard win-back
- Medium age (14–60 days): only reach out if there's a strong reason
  (e.g., they cited a specific issue and the changelog shows it's fixed)
- Old cancellations (60+ days): default to silence unless there's a
  very compelling match between their reason and recent improvements
```

The email tone should also adjust — never pretend it just happened:
- Fresh (< 7 days): "You recently cancelled..."
- Medium (7–30 days): "A few weeks ago you cancelled..."
- Older (30+ days): "We've made some changes since you left..."

---

## Dashboard page guard update

Current:
```typescript
if (!customer?.stripeAccessToken) redirect('/onboarding/stripe')
if (!customer?.onboardingComplete) redirect('/onboarding/changelog')
```

New:
```typescript
if (!customer?.stripeAccessToken) redirect('/onboarding/stripe')
// onboardingComplete is set in callback — no intermediate step
```

---

## Email pipeline guard

The existing webhook handler (`processChurn`) must NOT send emails to
backfilled subscribers that were already processed. The idempotency
check on `(customerId, stripeCustomerId)` handles this — if backfill
already inserted the row, the webhook will skip it.

---

## Migration

Single migration file: `migrations/XXX_onboarding_v2.sql`

```sql
-- Add source column to track how subscriber entered the system
ALTER TABLE wb_churned_subscribers
  ADD COLUMN source TEXT NOT NULL DEFAULT 'webhook';

-- Add skipped to allowed statuses (if using check constraint)
-- Otherwise status is just a text column — no DDL needed

-- Add backfill progress tracking to customers
ALTER TABLE wb_customers
  ADD COLUMN backfill_total INTEGER DEFAULT 0,
  ADD COLUMN backfill_processed INTEGER DEFAULT 0,
  ADD COLUMN backfill_started_at TIMESTAMPTZ,
  ADD COLUMN backfill_completed_at TIMESTAMPTZ;
```

---

## Definition of done

- [ ] Onboarding is a single page: connect Stripe → dashboard
- [ ] `/onboarding/changelog` and `/onboarding/review` removed (or redirect to `/dashboard`)
- [ ] Step progress component removed from onboarding
- [ ] Stripe callback sets `onboardingComplete = true` and triggers backfill
- [ ] Backfill pulls all cancelled subscriptions from Stripe (paginated)
- [ ] Each backfilled subscriber is classified by AI
- [ ] AI respects cancellation age — skips old/stale cancellations
- [ ] Email tone adjusts based on how long ago they cancelled
- [ ] New `skipped` status displayed on dashboard
- [ ] Dashboard banner shows backfill progress, then summary with lost MRR figure
- [ ] `source` column distinguishes backfill vs webhook subscribers
- [ ] Idempotency: webhook handler skips subscribers already backfilled
- [ ] Dashboard page guard no longer redirects to changelog step
- [ ] Existing tests updated/passing
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` green

# Spec 55 — Split pause control: win-back vs payment recovery

## Context

The Settings → "Stop Winback from sending" toggle currently pauses
*everything*: voluntary-cancel win-back emails AND failed-payment
dunning emails. The merchant gets one all-or-nothing kill switch
backed by a single `customers.paused_at` timestamp.

This conflates two genuinely-different things:

| | Win-back | Payment recovery |
|---|---|---|
| Trigger | Subscriber chose to cancel | Subscriber's card failed |
| Intent | Promotional / persuasive | Functional / transactional |
| Failure modes | AI hallucinates, changelog stale, tone off, classification wrong | Email template broken, branding wrong (rare) |
| Why a merchant would pause | "AI is sending bad messages, give me time to fix" — common | "Rebranding mid-flight" — rare |
| Risk of mis-sending | Embarrassing, looks like spam | Annoying but the subscriber genuinely needs to fix their card |

The dashboard already separates these into two tabs (Win-backs /
Payment recoveries — spec 40). Settings doesn't match. A merchant
who finds their win-back AI misclassifying needs to pause those
sends immediately while real subscribers' failed-payment update
emails keep going out. Today, that's impossible without code edits.

Surfaced via a side discovery during this work: `sendDunningEmail`
was *missing* the `isCustomerPausedForSubscriber` gate entirely
(only the followup variant was protected). The fix isn't to add the
gate — it's to put a *separate* dunning-specific gate there.

## Design philosophy (single sentence)

**One paused timestamp per cohort, gated separately at every
sender; merchants can stop win-back without stopping payment
recovery (and vice versa).**

## Goals

1. Two toggles in Settings — one for each email cohort.
2. Toggles are independent: pausing one does not affect the other.
3. Every subscriber-facing send path correctly gates on its own
   cohort's pause state.
4. Dashboard renders a clear paused-state banner that names which
   cohort(s) are paused, with a "Resume in Settings →" link.
5. Closes the latent bug where `sendDunningEmail` was un-gated.

## Non-goals

- **No master "pause everything" toggle.** Two separate toggles are
  enough; "pause both" is just flipping both. Adding a third
  master-toggle creates state-machine complexity (what happens if
  master is on but one sub is off?) for no real benefit.
- **No grouping with the Pilot / per-subscriber-AI-pause states.**
  Those are different concepts (pilot = free tier; per-row pause =
  founder pausing one subscriber). The Settings danger zone covers
  the customer-wide kill switches.
- **No UI for which subscribers were affected by the pause.** The
  paused gate logs `send_skipped_*_pause` events into `wb_events`
  for observability; an admin viewer for that is its own spec if
  ever needed.
- **No automatic re-pause / un-pause.** All toggles are manual.

## Design

### Schema — migration 035

The existing `customers.paused_at` becomes the win-back-specific
column (semantically). A new column tracks the dunning-specific
pause. Renaming `paused_at` → `paused_winback_at` would be cleanest
but requires touching every read site; instead we accept the slight
naming asymmetry and document it:

```sql
ALTER TABLE wb_customers
ADD COLUMN IF NOT EXISTS paused_dunning_at TIMESTAMP;

-- paused_at is repurposed as "paused_winback_at" semantically. A
-- comment on the column makes the intent obvious to anyone reading
-- the schema. (No data change — its meaning was already win-back
-- + dunning combined; we're narrowing to win-back-only.)
COMMENT ON COLUMN wb_customers.paused_at IS
  'Win-back send pause toggle (Settings danger zone). NULL = sending live, timestamp = paused.';
COMMENT ON COLUMN wb_customers.paused_dunning_at IS
  'Payment-recovery send pause toggle (Settings danger zone). NULL = sending live, timestamp = paused.';
```

Alternative considered: rename `paused_at` → `paused_winback_at` and
update all read sites. Rejected because it forks the spec into a
larger refactor with no functional benefit; the COMMENT achieves the
documentation goal.

### email.ts — split the helper, gate per cohort

Current state:
- `isCustomerPausedForSubscriber(subscriberId)` reads `paused_at`,
  used by `scheduleExitEmail`, `sendReplyEmail`,
  `sendDunningFollowupEmail`, and the reengagement cron.
- `sendDunningEmail` is missing the gate entirely (bug).

New state:

```ts
// Win-back cohort (voluntary cancels)
export async function isCustomerPausedForWinback(subscriberId: string): Promise<boolean> {
  // reads paused_at — same column as before, narrower name
}

// Payment-recovery cohort (failed payments / dunning)
export async function isCustomerPausedForDunning(subscriberId: string): Promise<boolean> {
  // reads paused_dunning_at
}

// Keep the legacy helper around as a thin wrapper that consults BOTH —
// not used by senders, but preserves any test/admin caller that wants
// "is anything paused?". Mark as deprecated; remove in a follow-up.
export async function isCustomerPausedForSubscriber(subscriberId: string): Promise<boolean> {
  return (await isCustomerPausedForWinback(subscriberId))
      || (await isCustomerPausedForDunning(subscriberId))
}
```

Gate-site changes:

| Sender | Previous gate | New gate |
|---|---|---|
| `scheduleExitEmail` | `isCustomerPausedForSubscriber` | `isCustomerPausedForWinback` |
| `sendReplyEmail` | `isCustomerPausedForSubscriber` | `isCustomerPausedForWinback` |
| **`sendDunningEmail`** | **— (bug)** | **`isCustomerPausedForDunning`** |
| `sendDunningFollowupEmail` | `isCustomerPausedForSubscriber` | `isCustomerPausedForDunning` |
| Reengagement cron's pre-filter | `isCustomerPausedForSubscriber` | `isCustomerPausedForWinback` (the cron only processes win-back cohort) |

Each skip emits an event so observability stays clear:
- `send_skipped_customer_paused_winback`
- `send_skipped_customer_paused_dunning`

### Settings UI

`app/settings/danger-zone.tsx` and `app/settings/pause-toggle.tsx`
become two-toggle layout. Each toggle is a thin variant of the
existing `PauseToggle` — same visual style, different label, different
POST scope.

```
┌──────────────────────────────────────────────────────────────┐
│ Stop Winback from sending                                    │
│ Safe to use. Cancellations + failed payments keep flowing    │
│ in — but no emails go out for the paused cohort.             │
├──────────────────────────────────────────────────────────────┤
│ ⏸  Pause win-back emails                          [Live ●]  │
│    For voluntary cancellations. Pause if your AI is          │
│    misclassifying or your changelog is out of date.          │
├──────────────────────────────────────────────────────────────┤
│ ⏸  Pause payment-recovery emails                  [Live ●]  │
│    For failed-payment subscribers. Pause if you're           │
│    rebranding or the dunning template needs work.            │
└──────────────────────────────────────────────────────────────┘
```

`app/api/settings/pause/route.ts` extends its body schema:

```ts
const bodySchema = z.object({
  scope: z.enum(['winback', 'dunning']),
  paused: z.boolean(),
})
```

Each toggle in the UI hits the same endpoint with its own `scope`.

### Dashboard banner

When either cohort is paused, render a persistent amber banner at
the top of the dashboard. Copy varies by which cohort(s):

- **Win-back only paused**:
  "⏸ Win-back emails are paused in Settings. New cancellations are
  still recorded — but no recovery emails go out until you resume.
  [Resume in Settings →]"
- **Dunning only paused**:
  "⏸ Payment-recovery emails are paused in Settings. New failed
  payments are still recorded — but no dunning emails go out until
  you resume. [Resume in Settings →]"
- **Both paused**:
  "⏸ All Winback emails are paused in Settings (win-back AND
  payment recovery). Nothing goes out until you resume.
  [Resume in Settings →]"

Banner styling: same amber-50 bg + amber-300 border + Link to
`/settings`. Independent of the spec 51/53 billing-paused banner —
both can coexist; the manual-pause banner renders first because it's
the more immediately reversible.

### Dashboard server component

`app/dashboard/page.tsx` reads `customer.pausedAt` and the new
`customer.pausedDunningAt`, passes both ISO strings to
`DashboardClient`:

```ts
manuallyPausedWinbackAtIso={customer?.pausedAt?.toISOString() ?? null}
manuallyPausedDunningAtIso={customer?.pausedDunningAt?.toISOString() ?? null}
```

`DashboardClient` uses both to decide which banner copy to render
(none / winback / dunning / both).

## Code paths touched

| File | Change |
|---|---|
| `src/winback/migrations/035_split_pause_control.sql` | **new** — add `paused_dunning_at` column + COMMENTs |
| `lib/schema.ts` | Add `pausedDunningAt` to `customers` table; doc comment on `pausedAt` |
| `src/winback/lib/email.ts` | Add `isCustomerPausedForWinback`, `isCustomerPausedForDunning`. Keep `isCustomerPausedForSubscriber` as legacy wrapper. Update 4 gate sites + add gate to `sendDunningEmail` |
| `app/api/cron/reengagement/route.ts` | Update gate import to `isCustomerPausedForWinback` |
| `app/api/settings/pause/route.ts` | Extend body schema with `scope` field; route to the right column |
| `app/settings/pause-toggle.tsx` | Accept `scope` prop; pass through to POST body |
| `app/settings/danger-zone.tsx` | Render two `PauseToggle` instances |
| `app/dashboard/page.tsx` | Read `pausedDunningAt` in addition to `pausedAt`; pass both ISOs |
| `app/dashboard/dashboard-client.tsx` | New banner component branching on which cohort(s) paused |
| `src/winback/__tests__/billing-pause-gate.test.ts` (or `pause-gate.test.ts` rename) | Cover both helpers + verify each sender gates on the right one |

## Edge cases

- **Subscriber matches both cohorts** (e.g., a payment-failed sub
  that the subscriber later actively cancels): each email type still
  consults the right gate. A win-back reply email gates on win-back
  pause; a dunning follow-up gates on dunning pause.
- **Race between toggle and in-flight send**: same-row UPDATE +
  per-send SELECT means a toggle flip is visible within the next
  send call. No locking needed — the worst case is one extra email
  goes out before the new state propagates, which is acceptable.
- **Both toggles paused while a recovery happens** (the
  trial-complete email): trial-complete is sent regardless of pause
  state because it's a transactional confirmation, not a marketing
  send. (Existing behaviour — out of scope to change here.)
- **Legacy callers**: `isCustomerPausedForSubscriber` stays as an
  OR-wrapper so any existing call sites I missed still behave
  reasonably (skipping when either cohort is paused — overly
  cautious but not broken).
- **Pilot bypass**: not affected. Pilot is a billing-state concept
  (no charges); merchant-pause is a sending-state concept. They're
  orthogonal.
- **Drain on subscribe** (spec 54): the drain processes cancellations
  AND dunning AND replies. Each underlying send goes through its
  cohort's gate. If a merchant has paused dunning, the drain still
  processes dunning rows but each `sendDunningEmail` call skips.
  Rows still get marked `pause_drain_processed_at` because the
  drain reached a terminal decision for that row (the gate fired,
  not the LLM). Acceptable semantics.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` all green; tests updated:
  - [ ] `isCustomerPausedForWinback` returns true only when
        `paused_at` set
  - [ ] `isCustomerPausedForDunning` returns true only when
        `paused_dunning_at` set
  - [ ] Each subscriber-facing sender gates on the right helper
- [ ] Migration 035 applied to dev Neon branch
- [ ] **Manual e2e on dev:**
  - [ ] Toggle "Pause win-back" only → simulate a cancellation →
        verify `scheduleExitEmail` skipped, dunning still fires for
        a separate payment-failed subscriber
  - [ ] Toggle "Pause payment recovery" only → simulate a payment
        failure → verify `sendDunningEmail` skipped, win-back still
        fires for a voluntary cancellation
  - [ ] Toggle both → both cohorts skip
  - [ ] Untoggle → both flow normally
  - [ ] Dashboard banner renders correct copy for each state
        combination (winback only / dunning only / both / neither)
  - [ ] "Resume in Settings →" link works
- [ ] Apply migration 035 to prod Neon main branch before merging

## Out of scope

- Renaming `paused_at` → `paused_winback_at` at the schema level
  (deferred — COMMENT is enough for now)
- Removing the legacy `isCustomerPausedForSubscriber` helper
  (deferred — wrapper is harmless, removing is a separate cleanup)
- Scheduled pause (e.g., "pause from 6pm to 8am") — out of scope
- Per-subscriber-cohort pause overrides — already covered by the
  existing per-row `aiPausedUntil` mechanism (spec 22a)
- Email-cohort-specific failure modes (e.g., "pause if more than N
  classification errors in 1h") — automatic kill switch is a
  separate, larger concern

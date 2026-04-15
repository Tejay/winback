# Spec 11 — Danger Zone (Settings)

A single card at the bottom of `/settings` that groups two high-blast-radius
actions: **Pause sending** (reversible) and **Delete workspace** (irreversible).
Visually distinct (pink/rose palette) so the eye knows this is a different
class of button from the rest of the page.

## Goals

1. Consolidate destructive / "stop the world" actions in one visually loud place.
2. Make **pause** the obvious first choice for anyone hovering over delete.
3. Make **delete** possible but deliberate — three gates of friction that a
   determined user clears in ~60 seconds, an accidental click never does.
4. Actually delete: tokens, subscribers, recoveries, emails, user, session.
   No soft-delete, no grace period — we promised "This cannot be undone" on
   the consequence screen, and the FAQ says 30-day deletion under GDPR Art. 17.

## UX — the card

Bottom of `/settings`, matches the screenshot:

- Outer card: `bg-rose-50/50 border-rose-200 rounded-2xl p-6`
- Eyebrow: `DANGER ZONE` — `text-xs font-semibold uppercase tracking-widest text-rose-600`
- Title: **Stop Winback from sending** — `text-xl font-semibold text-slate-900`
- Subtitle: `Safe to use. Cancellations keep flowing in — nothing is sent until you resume.`
- Two inner rows (white card, rose-100 border), each with icon / title+desc / action button.

### Row 1 — Pause all winback emails
Replaces the standalone "Sending" section. Reuses the existing
`<PauseToggle initialPaused={...} />` component, restyled to a rose button when live.

### Row 2 — Delete workspace
Button `Delete workspace` (rose outline). Clicking navigates to `/settings/delete`.

## Delete flow — three gates

### Gate 1 — Consequence screen (`/settings/delete`)

Server component. Fetches real numbers:

```
- subscribersCount   = churned_subscribers where customerId = ?
- recoveriesCount    = recoveries where customerId = ?
- recoveredCents     = sum(planMrrCents) across recoveries where customerId = ?
                       (months counted = min(12, monthsSinceRecoveredAt))
- pausedAt           = customers.pausedAt (controls the "pause instead" CTA)
```

Layout:
- Header: **Before you delete your workspace**
- Red list of everything that will be destroyed, with real numbers:
  - Disconnect Stripe (if connected)
  - Delete `{subscribersCount}` churned-subscriber records
  - Delete `{recoveriesCount}` recoveries worth £`{recoveredCents/100}` recovered
  - Cancel billing immediately
  - Remove all in-progress email sequences
- Copy: "This cannot be undone. There is no grace period."
- One-time alternative (only if `!pausedAt`):
  > Not ready to delete? [Pause all emails instead] — your data stays intact
  > and you can reactivate anytime.
- Continue button → reveals Gate 2 on the same page (progressive disclosure).
- Secondary button: "Cancel, take me back to Settings."

### Gate 2 — Typed confirmation

Client component (`delete-confirmation.tsx`). Revealed after clicking continue.

- Label: **Type your workspace name to confirm deletion:**
- Input: full-width text, `focus:ring-rose-500`
- Below: `Your workspace name is: {workspaceName}` (monospace)
- Workspace name = `productName ?? email` (no spaces; if productName has spaces we slugify to lowercase-hyphenated).
- Delete button disabled until exact match (case-insensitive, trimmed).

### Gate 3 — Final button + 3-second real countdown

- Button text: **Permanently delete workspace**
- Styling: `bg-rose-600 text-white rounded-full px-6 py-2.5`
- On click (match valid): button disables, text changes to "Deleting in 3… 2… 1…"
  on real `setTimeout` (not fake — the delay is the UX).
- After 3s: POST `/api/settings/delete` with `{ confirmation: typedValue }`.
- Server re-validates the match (client-side is not trusted).
- On 200: client clears local state, hits `/api/auth/signout?callbackUrl=/`
  via `signOut()` from `next-auth/react`.

## API

### `GET /api/settings/stats`
Auth-gated. Returns numbers the consequence screen needs.
```
{
  workspaceName: string
  subscribersCount: number
  recoveriesCount: number
  recoveredCents: number   // sum of attributed revenue already recognised
  stripeConnected: boolean
  pausedAt: string | null
}
```
_Alternative:_ fetch these directly in the `/settings/delete` server component.
We'll go with the server-component path to avoid a round-trip — no new route needed.

### `POST /api/settings/delete`
Auth-gated. Body `{ confirmation: string }`.
- Load customer for this userId.
- Compute `expected = slugify(productName ?? email)`.
- If `confirmation.trim().toLowerCase() !== expected` → 400.
- Transaction (Drizzle `db.transaction`):
  1. `DELETE FROM wb_recoveries WHERE customer_id = ?` (no cascade on this table)
  2. `DELETE FROM wb_users WHERE id = ?` — cascades to:
     - `wb_customers` (cascade) → `wb_churned_subscribers` (cascade)
       → `wb_emails_sent` (cascade)
     - `wb_legal_acceptances` (cascade)
- Return `{ ok: true }`.
- Client then signs out.

## Files touched / added

```
Added:
  specs/11-danger-zone.md                       (this file)
  app/settings/danger-zone.tsx                  (server + composes Pause into rose card)
  app/settings/delete/page.tsx                  (Gate 1, server component)
  app/settings/delete/delete-confirmation.tsx   (Gate 2 + 3 client component)
  app/api/settings/delete/route.ts              (POST — deletes workspace)
  src/winback/__tests__/delete-workspace.test.ts (slugify + gate validation)

Modified:
  app/settings/page.tsx                         (replace Section 1b Sending with Danger Zone at bottom)
  app/settings/pause-toggle.tsx                 (optional rose variant prop for use in Danger Zone)
```

## Non-goals

- Soft delete / undo window. Explicit decision: the consequence screen says
  "cannot be undone" — honouring that is the trust play.
- Stripe OAuth `deauthorize` call. We null the tokens locally; the user can
  revoke in Stripe → Apps independently. Adding a Stripe-side deauth is a
  roadmap item (`TASKS.md` Phase 10.4).
- Export-before-delete. GDPR Art. 20 right is handled via a separate email
  request per `/privacy` — not wiring that into the self-serve flow yet.
- Re-signup with the same email. Users row is hard-deleted; the email becomes
  available again immediately.

## Verification

- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — existing tests green + new `delete-workspace` tests
- [ ] Settings shows Danger Zone card at bottom with Pause + Delete rows
- [ ] `/settings/delete` shows real numbers pulled from DB
- [ ] Pause-instead CTA hidden when already paused
- [ ] Continue button reveals typed-confirmation input
- [ ] Delete button is disabled until text matches exactly
- [ ] On confirm: 3-second countdown, then API call, then signed out to `/`
- [ ] Attempting the API call with a wrong confirmation string returns 400
- [ ] After deletion, the user row + customer row + all child rows are gone
      from Neon (verify with `psql` query)

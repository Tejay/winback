# Spec 80 — Promo codes: manual-default mode (drawer + bulk)

> **Builds on Spec 79** (`79-promo-codes-foundation.md`). Spec 79
> shipped the auto-sync, attribution, and tests that make today's
> matcher-driven promo path trustworthy. This spec inverts the
> default: manual becomes the new shape; today's automatic matcher
> stays as an opt-in flag. Reuses spec 79's gates, attribution
> column, and reactivate flow verbatim.

## Context

Today the promo subsystem is fully automatic. The matcher
(`tryPromotionPath` in `src/winback/lib/reengagement-cron-v2.ts`) fires
whenever a subscriber meets hardcoded gates (`tier === 1` +
`cancellationCategory === 'Price'`) plus the 4 Stripe gates. Merchants
toggle the whole thing on/off; they can't intervene per-subscriber.

That's good for set-and-forget but breaks down when:

- Merchant wants to vet each offer (low-volume B2B, VIP accounts)
- Classifier mis-classifies a price-cancellation as Feature → silently excluded
- Merchant wants to offer to tier-2 subscribers the matcher won't touch
- Merchant wants to send a one-off custom offer to a specific churned
  subscriber

The proposed pivot: **manual mode becomes the default**, automatic mode
becomes an opt-in flag. Merchants who want today's autopilot can flip
the switch; merchants who want full control get it by default. The
manual "send promo to this subscriber" action is **always available** —
even when auto mode is on — so it doubles as a VIP-override hatch.

## Principles

1. **Stripe is still master.** The 4 gates (active / redeemBy /
   maxRedemptions / appliesToPriceIds) re-validate server-side on
   every send, manual or automatic.
2. **No automatic sends in manual mode.** Matcher's promo path
   short-circuits when the auto flag is off. Other matcher paths
   (improvement match) still fire — only the promo path is gated.
3. **Identical subscriber experience.** Same email shape, same
   reactivate flow, same Stripe Checkout with discount pre-attached.
4. **Same attribution.** `wb_recoveries.applied_improvement_id` still
   records which promo drove which recovery. Dashboard chip + per-code
   30d metric on `/reasons` work identically for manual vs automatic.
5. **Audit trail.** Manual sends record which user clicked the button.
   Source ('manual' vs 'automatic') is queryable for analytics.

## How it works

### Two modes, one switch

- `wb_customers.promo_auto_mode_enabled` (boolean, default `false`)
- UI on `/reasons`: top of the promo section, "Automatic promo sends:
  [off | on]" toggle. When off: rule-disclosure subtitle changes to
  *"Manual mode — open a churned subscriber from the dashboard and
  click 'Send promo offer' to send."* When on: existing tier-1 + Price
  rule disclosure.

### Manual send — TWO entry points

Both surfaces share the same backend endpoint (single-subscriber
`POST /api/subscribers/[id]/send-promo`; bulk just calls it N times
server-side). They share eligibility components, the promo dropdown,
the email preview, the gate-status chip. They diverge on modal
layout and what they emphasise.

#### Entry point 1 — Drawer (single-subscriber)

For VIPs, edge cases the matcher excludes, custom one-offs.

1. Merchant on `/dashboard` clicks into a churned subscriber row to
   open the existing drawer/detail view.
2. Drawer gets a new **"Send promo offer"** action button. Disabled
   if no published promotions exist on the account; otherwise enabled
   for any churned subscriber (no tier/category gate at this layer —
   merchant judgment is the gate).
3. Click → single-subscriber modal:
   - Header: subscriber summary (name, plan, MRR, days since cancel,
     stripe_comment / cancellation reason)
   - **Promo dropdown:** lists every published `wb_improvements` row
     (`kind='promotion'`). Each option shows code + terms + a
     per-subscriber 4-gate status chip. Options where any gate fails
     are greyed out with the failing gate named (e.g. *"This promo
     only applies to Pro Plan — subscriber was on Starter"*).
   - **Email preview:** subject + body, pre-filled from
     `generatePromotionEmail()`. Editable inline.
   - **Optional internal note** (not shown to subscriber).
   - **Send** button: disabled until a promo is selected + all
     gates pass. If subscriber already received a promo within 30
     days, soft warning ("Already received WELCOME50 on May 18 —
     send anyway?") rather than block.

#### Entry point 2 — Dashboard multi-select (bulk)

For routine campaigns, cohort sends, time-saving.

1. Merchant filters the dashboard subscriber table (e.g. activates a
   new "Price cancellations" filter chip alongside the existing
   status filters). Filter chips are surface for discovery — also
   useful when merchant just wants to *read* the cohort without
   sending.
2. Row checkboxes appear in the leftmost column. As soon as any row
   is checked, a blue action bar slides in above the table:
   *"5 selected · 1 already received a promo in last 30d"* with
   "Send promo offer →" and "Clear" actions.
3. Click → bulk modal:
   - Header: *"Send promo offer to 5 subscribers"*
   - Cohort summary: filter applied + named subscribers (or, if too
     many to list, count + "Show all 47 names" expander)
   - **Promo dropdown** (same component as drawer)
   - **Eligibility breakdown chips** aggregated across the cohort:
     `4 eligible` `1 blocked` `1 recently contacted`. Blocked detail
     names who and why ("Aisha Khan — only applies to Pro Plan, she's
     on Starter").
   - **Estimated impact:** recovered MRR if all eligible reactivate,
     total discount cost, net over 12 months. Helps a merchant feel
     safe pressing the button on a big batch.
   - **No per-subscriber email editing in bulk** — one template, one
     subject. Per-subscriber tweaks happen via the drawer flow.
   - **Send to N eligible** button — number is honest (skips
     blocked).
4. Footer link "← Pick subscribers individually" drops merchant back
   to multi-select if they want to exclude specific people before
   sending.

#### Both flows: server-side write path

On send (single or per-item in a bulk): server re-validates the 4
Stripe gates for that subscriber's `stripePriceId`, generates the
final email body via `generatePromotionEmail()` (or overrides if
provided in the drawer flow), sends via Resend, writes
`wb_emails_sent` with `source='manual'` +
`sent_by_user_id=session.user.id` + `improvement_id`, writes the
existing `wb_improvement_matches` dedup row.

Reactivate flow handles the email click identically to auto-sent
emails (no changes there). Recovery row records
`applied_improvement_id`. Dashboard chip lights up.

### Automatic mode (opt-in, today's behavior)

When the toggle is on, nothing else changes. `tryPromotionPath` runs
exactly as it does today, gated on:
`customer.promo_auto_mode_enabled === true` (new gate at top of the
function) + the existing 8 gates. **The manual "Send promo offer"
button stays available** — merchant can still send VIP overrides for
subscribers the matcher would not have touched (tier 2, Feature
category, etc).

## File changes

### Schema (migration 054)

```sql
ALTER TABLE wb_customers
  ADD COLUMN promo_auto_mode_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE wb_emails_sent
  ADD COLUMN source TEXT,
  ADD COLUMN sent_by_user_id UUID REFERENCES wb_users(id) ON DELETE SET NULL;

-- Backfill: all existing emails predate manual sends → 'automatic'.
UPDATE wb_emails_sent SET source = 'automatic' WHERE source IS NULL;
```

Migration is additive + backfillable; safe to apply hot.

### Modify

- `lib/schema.ts` — mirror the 3 new columns.
- `src/winback/lib/reengagement-cron-v2.ts::tryPromotionPath` — add
  `if (!customer.promoAutoModeEnabled) return null` as the first
  gate. Matcher otherwise unchanged.
- `app/reasons/promotions-section.tsx` — add the automatic-mode
  toggle above the existing promo selector. Subtitle text branches
  on the toggle state.
- `app/api/customer/promotions-enabled/route.ts` — extend to also
  accept `promoAutoModeEnabled` (or add a sibling PATCH endpoint;
  whichever fits the existing pattern cleaner).

### Add

**Backend (shared):**
- `app/api/subscribers/[id]/send-promo/route.ts` — POST endpoint.
  Validates session + ownership, re-validates 4 Stripe gates against
  the chosen promo for this subscriber's `stripePriceId`, calls
  `generatePromotionEmail` (or uses overrides if provided), calls
  `sendEmail`, writes `wb_emails_sent` (`source='manual'`,
  `sent_by_user_id`) + `wb_improvement_matches`. Both drawer and
  bulk flows hit this endpoint — bulk just calls it N times. Reuses
  existing utilities throughout; no new business logic.

**Shared client components (used by both modals):**
- `app/dashboard/promo/promo-dropdown.tsx` — promo selector with
  per-subscriber 4-gate status chips. Takes a subscriber +
  promo-list; renders enabled/disabled rows with failing-gate
  tooltips.
- `app/dashboard/promo/email-preview.tsx` — subject + body preview
  panel. Editable in drawer flow, read-only in bulk flow.
- `app/dashboard/promo/gate-chip.tsx` — small "All 4 gates pass" /
  "Wrong plan" / "Expired" chip used in both modals + the per-promo
  list.

**Drawer flow:**
- `app/dashboard/promo/send-promo-drawer-modal.tsx` — single-
  subscriber modal. Subscriber summary header + shared promo
  dropdown + editable email preview + optional internal note + send.
- Wire-up in the existing subscriber drawer (in
  `app/dashboard/dashboard-client.tsx` — search for the existing
  drawer markup) — adds a "Send promo offer" action button.

**Bulk flow:**
- `app/dashboard/promo/send-promo-bulk-modal.tsx` — cohort summary
  header + shared promo dropdown + aggregated eligibility breakdown
  + estimated impact cost preview + send-to-N-eligible button +
  "Pick individually" escape hatch back to multi-select.
- New filter chip on the dashboard table: "Price cancellations"
  (cohort filter, leverages existing `cancellationCategory`
  classifier output — no new schema needed).
- Row checkboxes + multi-select state management in
  `app/dashboard/dashboard-client.tsx`.
- Action bar component that appears when `selectedRows.length > 0`.

### Reuse from spec 79

- `getApplicablePromotionForSubscriber()` in
  `src/winback/lib/promotion-match.ts` — the 4 Stripe gates. Called
  both by the matcher (auto mode) and by the new manual endpoint.
- `loadAppliedPromotionForSubscriber()` in
  `src/winback/lib/promotions.ts` — unchanged; the reactivate flow
  still uses it to attach the discount at checkout.
- `formatPromotionChip()` — unchanged; same dashboard chip lights up.
- Per-code 30d metric query on `/reasons` — unchanged; now includes
  manual-sourced recoveries automatically (since the join is on
  `applied_improvement_id`, not on the email's source).

### Tests

- `src/winback/__tests__/promotion-match.test.ts` — extend with
  cases where the matcher is called but
  `customer.promoAutoModeEnabled = false`. Expected: returns null
  regardless of all other gates passing.
- New: `src/winback/__tests__/send-promo-endpoint.test.ts` — exercises
  the new POST endpoint. Cases: gate failure → 4xx with explanation,
  archived improvement → rejected, missing promo selection → 4xx,
  successful send → inserts emailsSent + improvementMatches rows
  with correct source / sent_by_user_id.
- Extend the existing E2E driver `scripts/test-promo-e2e.ts` with a
  `--mode=manual` flag that exercises the new endpoint instead of
  the matcher path.

## What stays / what goes

| Stays | Goes / Changes |
|---|---|
| Stripe sync (webhooks + manual refresh) | `tryPromotionPath` gains one new gate at the top |
| `wb_improvements` storage | UI subtitle text on `/reasons` switches based on toggle |
| 4 Stripe gates (in `promotion-match.ts`) | Hardcoded `tier === 1` + `cancellationCategory === 'Price'` only applies in auto mode |
| Reactivate flow + Stripe Checkout integration | Manual mode is the new-merchant default |
| `applied_improvement_id` attribution | — |
| Dashboard chip + per-code 30d metric | — |
| All 20 promotion-match unit tests | — |
| Promo selector + refresh button on `/reasons` | — |

Net: small, additive change. No deletions. Existing automation is
preserved as an opt-in.

## Open question

**For existing merchants in production, what's their default after
migration 054 lands?**

Two options:

- **A.** All existing merchants get `promo_auto_mode_enabled = false`
  (the column default). Anyone currently relying on auto would
  silently lose it until they flip the switch. **Risk:** recoveries
  drop for the gap between deploy and merchant noticing.
- **B.** Migration 054 backfills `promo_auto_mode_enabled = true` for
  every existing merchant that has `promotions_enabled = true`.
  Preserves current behavior. New merchants get manual default.

B is the safer migration. A is more "honest about the pivot." Worth
explicit sign-off before implementation.

## Effort

- Schema + matcher gate + migration: ~half day
- Send-promo endpoint + tests: ~1 day
- Shared components (promo dropdown, email preview, gate chip): ~half day
- Drawer modal + drawer wire-up: ~half day
- Bulk modal + cohort summary + cost preview: ~1.5 days
- Multi-select + filter chip + action bar wiring on dashboard: ~half day
- E2E driver flag + manual test (both flows): ~half day

**Total: ~4.5 days** for the core (drawer + bulk both shipped together).
+0.5 day for the analytics breakdown ("X manual / Y automatic sends in
last 30d") on `/reasons` if wanted.

## HTML mockup of the manual send modal

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>Send promo offer</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,system-ui,sans-serif; background:#0f172a99; color:#0f172a; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:40px; }
  body::before { content:''; position:fixed; inset:0; background:#f5f5f5 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'><rect width='100%25' height='100%25' fill='%23f5f5f5'/><text x='40' y='80' font-family='system-ui' font-size='20' fill='%23475569'>Cancelled subscribers</text><rect x='30' y='110' width='540' height='60' rx='8' fill='%23dbeafe' stroke='%23bfdbfe'/><text x='48' y='135' font-family='system-ui' font-size='14' fill='%230f172a' font-weight='600'>Sarah Chen</text><text x='48' y='154' font-family='system-ui' font-size='12' fill='%2364748b'>Pro · £39/mo · cancelled 3d ago</text></svg>") no-repeat top left/auto; z-index:-1; }
  .modal { background:white; border-radius:20px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.25); max-width:560px; width:100%; overflow:hidden; }
  .header { padding:24px 28px 0; display:flex; justify-content:space-between; align-items:flex-start; }
  .header h1 { font-size:20px; margin:0 0 4px; font-weight:700; }
  .header p { font-size:13px; color:#64748b; margin:0; }
  .close { background:none; border:none; font-size:20px; color:#94a3b8; cursor:pointer; padding:4px 8px; }
  .body { padding:20px 28px; }
  .sub-summary { background:#f8fafc; border:1px solid #f1f5f9; border-radius:12px; padding:14px 16px; margin-bottom:20px; }
  .sub-name { font-weight:600; font-size:14px; }
  .sub-meta { font-size:13px; color:#64748b; margin-top:4px; }
  .sub-reason { font-size:13px; color:#475569; margin-top:6px; font-style:italic; }
  .label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em; color:#2563eb; margin-bottom:8px; }
  .promo-list { border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; margin-bottom:20px; }
  .promo-row { display:flex; align-items:center; gap:12px; padding:12px 14px; border-bottom:1px solid #f1f5f9; cursor:pointer; }
  .promo-row:last-child { border-bottom:none; }
  .promo-row.selected { background:#eff6ff; border-color:#3b82f6; }
  .promo-row.disabled { opacity:0.5; cursor:not-allowed; background:#fafafa; }
  .radio { width:16px; height:16px; border-radius:50%; border:2px solid #cbd5e1; flex-shrink:0; display:flex; align-items:center; justify-content:center; }
  .radio.checked { border-color:#2563eb; }
  .radio.checked::after { content:''; width:8px; height:8px; border-radius:50%; background:#2563eb; }
  .promo-code { font-family:ui-monospace,monospace; font-size:13px; font-weight:600; color:#0f172a; }
  .promo-terms { font-size:13px; color:#475569; }
  .promo-status { margin-left:auto; font-size:11px; font-weight:500; padding:2px 8px; border-radius:9999px; }
  .promo-status.ok { background:#dcfce7; color:#166534; }
  .promo-status.bad { background:#fef2f2; color:#991b1b; }
  .gate-note { font-size:11px; color:#94a3b8; margin-left:28px; padding:0 14px 8px; }
  textarea { width:100%; min-height:90px; border:1px solid #e2e8f0; border-radius:10px; padding:10px 12px; font:inherit; font-size:13px; resize:vertical; box-sizing:border-box; }
  .email-preview { background:#fafafa; border:1px solid #f1f5f9; border-radius:10px; padding:12px 14px; font-size:13px; line-height:1.5; color:#334155; margin-bottom:6px; }
  .email-preview .sub { font-weight:600; color:#0f172a; margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid #e2e8f0; }
  .edit-link { font-size:11px; color:#2563eb; text-decoration:none; }
  .warning { background:#fef9c3; border:1px solid #fde68a; border-radius:10px; padding:10px 14px; font-size:12px; color:#854d0e; margin:14px 0 16px; display:flex; gap:8px; align-items:flex-start; }
  .warning::before { content:'⚠'; font-size:14px; }
  .footer { display:flex; justify-content:flex-end; gap:8px; padding:16px 28px 24px; border-top:1px solid #f1f5f9; background:#fafafa; }
  .btn { padding:9px 18px; border-radius:9999px; font-size:13px; font-weight:500; border:none; cursor:pointer; }
  .btn-secondary { background:white; border:1px solid #e2e8f0; color:#334155; }
  .btn-primary { background:#0f172a; color:white; }
  .btn-primary:hover { background:#1e293b; }
  .field { margin-bottom:18px; }
</style>
</head><body>
  <div class="modal">
    <div class="header">
      <div>
        <h1>Send promo offer</h1>
        <p>Manually offer a discount to one churned subscriber</p>
      </div>
      <button class="close">✕</button>
    </div>
    <div class="body">
      <div class="sub-summary">
        <div class="sub-name">Sarah Chen</div>
        <div class="sub-meta">Pro Plan · £39/month · cancelled 3 days ago</div>
        <div class="sub-reason">"Too expensive for what I'm getting out of it"</div>
      </div>

      <div class="field">
        <div class="label">Promo to send</div>
        <div class="promo-list">
          <div class="promo-row selected">
            <div class="radio checked"></div>
            <span class="promo-code">WELCOME50</span>
            <span class="promo-terms">· 50% off · 3 months</span>
            <span class="promo-status ok">All 4 gates pass</span>
          </div>
          <div class="promo-row disabled">
            <div class="radio"></div>
            <span class="promo-code">STARTERONLY25</span>
            <span class="promo-terms">· 25% off · forever</span>
            <span class="promo-status bad">Wrong plan</span>
          </div>
          <div class="gate-note">Only applies to Starter — subscriber was on Pro</div>
          <div class="promo-row disabled">
            <div class="radio"></div>
            <span class="promo-code">SPRING_FLASH</span>
            <span class="promo-terms">· 30% off · once</span>
            <span class="promo-status bad">Expired</span>
          </div>
          <div class="gate-note">Promo deadline was 2 days ago</div>
        </div>
      </div>

      <div class="field">
        <div class="label">Email preview <a href="#" class="edit-link">edit ↑</a></div>
        <div class="email-preview">
          <div class="sub">Subject: We heard you — 50% off your Pro plan for 3 months</div>
          Hi Sarah,<br><br>
          You mentioned the price was tight for what you were getting out of Fitness App. We've been working on the feature gap you flagged, and we'd love to have you back at a reduced rate while we get there.<br><br>
          25% off your Pro plan for 3 months, applied automatically at checkout.
        </div>
      </div>

      <div class="warning">
        Sarah received <strong>PROMO_OLD</strong> 12 days ago. Send anyway?
      </div>

      <div class="field">
        <div class="label">Internal note (optional)</div>
        <textarea placeholder="Why are we sending? (not shown to subscriber)"></textarea>
      </div>
    </div>
    <div class="footer">
      <button class="btn btn-secondary">Cancel</button>
      <button class="btn btn-primary">Send promo offer →</button>
    </div>
  </div>
</body></html>
```

## Verification

### Manual end-to-end — drawer flow

1. Merchant on fresh account → auto toggle defaults to off → /reasons
   shows manual-mode subtitle.
2. Cancel a subscriber via `scripts/test-promo-e2e.ts` (or real
   churn flow) with a price reason. Verify NO promo email goes out.
3. Open the subscriber in the dashboard drawer → "Send promo offer" →
   modal opens → all 4 gates green → send. Verify email lands.
4. Subscriber clicks email → Stripe Checkout with discount → test
   card → recovery row inserted with `applied_improvement_id`. Chip
   lights up.
5. Open the same subscriber again → drawer "Send promo offer" → warn
   "Already received WELCOME50 7 minutes ago — send anyway?" →
   override → second send succeeds.

### Manual end-to-end — bulk flow

6. Cancel 5 more subscribers via `scripts/test-promo-e2e.ts --batch=5`
   (extend driver), each with a price reason.
7. On dashboard, click "Price cancellations" filter → table shows all
   5 + the one from steps 2-5.
8. Check 3 rows → action bar appears with "3 selected · 1 already
   received a promo in last 30d" → "Send promo offer →".
9. Bulk modal opens: cohort summary lists 3 names, eligibility
   breakdown shows 3 eligible / 0 blocked / 1 recently contacted,
   cost preview shows estimated MRR vs discount → "Send to 3
   eligible →".
10. All 3 receive the email. 3 `wb_emails_sent` rows inserted with
    `source='manual'` + same `sent_by_user_id`. Subscribers click +
    complete checkout → 3 recoveries with `applied_improvement_id`
    + chips on dashboard.

### Auto-mode regression

11. Flip auto toggle to on → cancel another fixture → verify matcher
    fires the promo path automatically (today's behavior preserved
    end-to-end).

### Automated

- All existing promo unit tests pass unchanged.
- New promotion-match test: matcher returns null when
  `promoAutoModeEnabled = false` regardless of other gates.
- New send-promo endpoint test: gate failures rejected with clear
  errors; successful sends record source='manual' + sent_by_user_id.

### Backfill verification (if going with option B)

- After migration 054 + backfill: query
  `SELECT count(*) FROM wb_customers WHERE promotions_enabled = true AND promo_auto_mode_enabled = false`
  → should be 0. (Every auto-promo merchant preserved their behavior.)

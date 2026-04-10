# Spec 05 — Dashboard Page

**Phase:** 5
**Depends on:** Spec 01 (TopNav, StatusBadge), Spec 04 (data in database)
**Reference:** https://churntool-jxgo.vercel.app/dashboard
**Estimated time:** 3 hours

---

## app/dashboard/page.tsx

Server component. Redirect to `/login` if no session.

```tsx
<TopNav userName={session.user.name} />
<main className="min-h-screen bg-[#f5f5f5]">
  <div className="max-w-5xl mx-auto px-6 py-8">
    {/* content */}
  </div>
</main>
```

---

## Page header

```
OVERVIEW                                      [Update changelog]
Dashboard.
Every cancellation, every recovery — all in one view.
```

- `"OVERVIEW"` — blue section label
- `"Dashboard."` — `text-4xl font-bold text-slate-900` (note: trailing period)
- Subtitle — `text-sm text-slate-500 mt-1`
- `"Update changelog"` — secondary button, right-aligned in same row as "OVERVIEW"

On "Update changelog" click: open a dialog/modal with the same large textarea as onboarding Step 3.
On save: `PUT /api/changelog` with new content → updates `wb_customers.changelog_text`.

---

## Billing alert banner

Show this when: `recoveries.length >= 1 AND customer.plan === 'trial'`

Dismissable with ✕ button. Store dismissed state in `localStorage`.

```
bg-white border border-slate-200 rounded-2xl p-5 mb-6
flex items-start justify-between gap-4
```

Left section (`flex items-start gap-4`):
- Blue lightning bolt icon in `bg-blue-50 rounded-full p-2 flex-shrink-0`
- Text block:
  - `"🎉 Your first recovery is in — {name} is back at ${mrr}/mo."` — `text-sm font-medium text-slate-900`
  - `"That one was on us. Your next recovery starts billing at "` + **`"£49/mo + 10% of recovered MRR"`** (bold) + `" (first year each subscriber stays back). "` + blue link `"You have {N} cancellations waiting."` — `text-sm text-slate-600 mt-1`
  - Button row (`mt-3 flex items-center gap-4`):
    - `"Add billing to keep recovering"` — primary dark button → `/settings#billing`
    - `"Not now"` — `text-sm text-slate-400 hover:text-slate-600`

Right section:
- `✕` button — `text-slate-400 hover:text-slate-600`

---

## Stat cards

`grid grid-cols-4 gap-4 mb-6`

Each card: `bg-white rounded-2xl border border-slate-100 p-6`

**Card 1 — Recovery Rate:**
- Icon: trending-up arrow in `bg-green-50 rounded-xl w-9 h-9 flex items-center justify-center text-green-600`
- Value: `{recoveryRate}%` — `text-4xl font-bold text-slate-900 mt-3`
- Label: `"RECOVERY RATE"` — `text-xs font-semibold uppercase tracking-widest text-slate-400 mt-1`

**Card 2 — Recovered:**
- Icon: check-circle in `bg-green-50`
- Value: count of recovered subscribers
- Label: `"RECOVERED"`

**Card 3 — MRR Recovered:**
- Icon: dollar/currency sign in `bg-green-50`
- Value: `$${mrrRecovered}` (convert `mrrRecoveredCents / 100`, round to nearest dollar)
- Label: `"MRR RECOVERED"`

**Card 4 — At Risk:**
- Icon: people/users in `bg-amber-50 text-amber-600`
- Value: count of pending + contacted subscribers
- Label: `"AT RISK"`

**`GET /api/stats` endpoint:**
- Requires auth session
- Returns:
  ```typescript
  {
    recoveryRate:      number,  // Math.round((recovered / total) * 100) or 0 if total === 0
    recovered:         number,  // count where status = 'recovered'
    mrrRecoveredCents: number,  // sum of plan_mrr_cents in wb_recoveries where still_active = true
    atRisk:            number,  // count where status IN ('pending', 'contacted')
  }
  ```

---

## Filter tabs + search

```
[All] [Pending] [Contacted] [Recovered] [Lost]         [🔍 Search name, email, reason]
```

**Tabs:**
Active tab: `bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium`
Inactive tab: `text-slate-500 hover:text-slate-900 rounded-full px-4 py-1.5 text-sm font-medium transition-colors`

**Search input:**
`border border-slate-200 rounded-full px-4 py-2 text-sm w-64 pl-10` with search icon at left inside.

Filter and search are client-side state. On change, re-fetch from `/api/subscribers`.

---

## Subscriber table

`mt-4` below filter row.

**Column headers** (`text-xs font-semibold uppercase tracking-wide text-slate-400 py-3 border-b border-slate-100`):
```
SUBSCRIBER  |  PLAN  |  CANCELLED  |  REASON  |  STATUS  |  MRR
```

**Each row** (clickable → opens detail panel):
```
hover:bg-slate-50 cursor-pointer border-b border-slate-50 transition-colors
```

Row columns:
- **SUBSCRIBER**: `py-4 pr-4`
  - Name: `text-sm font-medium text-slate-900`
  - Email: `text-xs text-slate-400 mt-0.5`
- **PLAN**: `text-sm text-slate-600 py-4`
- **CANCELLED**: `text-sm text-slate-600 py-4` — format as `YYYY-MM-DD`
- **REASON**: `text-sm text-slate-600 py-4` — `cancellationReason`, truncate at 45 chars with ellipsis
- **STATUS**: `py-4` — `<StatusBadge status={subscriber.status} />`
- **MRR**: `text-sm font-medium text-slate-900 py-4 text-right` — `$XX.XX`

**`GET /api/subscribers` endpoint:**
- Requires auth session
- Query params: `filter` (`all|pending|contacted|recovered|lost`), `search` (string)
- Filter by `status` column (if not `all`)
- Search by `name`, `email`, `cancellation_reason` using case-insensitive `ILIKE '%search%'`
- Return array ordered by `cancelled_at DESC`

---

## Subscriber detail panel

Opens as a slide-in from the right when any table row is clicked.
Does NOT navigate to a new URL.

**Overlay:** `fixed inset-0 bg-black/20 z-40` — click overlay to close panel

**Panel:** `fixed right-0 top-0 h-full w-96 bg-white shadow-xl border-l border-slate-100 z-50 overflow-y-auto`

**Panel header (`px-6 pt-6 pb-4 border-b border-slate-100`):**
```
SUBSCRIBER                              ✕
{subscriber.name}
```
- `"SUBSCRIBER"` — `text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1`
- Name — `text-xl font-bold text-slate-900`
- ✕ button — top right, `text-slate-400 hover:text-slate-600`

**Status + MRR row (`px-6 py-4 flex items-center justify-between`):**
```
[Pending badge]                     MRR
                                    $24.99
                                    text-xl font-bold text-slate-900
```

**2×2 info grid (`grid grid-cols-2 gap-3 px-6`):**
Each cell: `bg-slate-50 rounded-xl p-3`
- Label: `text-xs font-semibold uppercase tracking-widest text-slate-400 mb-1`
- Value: `text-sm font-medium text-slate-900`

```
[EMAIL]               [PLAN]
tom@northlab.no       Pro

[CANCELLED]           [TENURE]
2026-04-07            22 months
```

**Cancellation reason card (`mx-6 mt-4 bg-blue-50 rounded-xl p-4`):**
- `"CANCELLATION REASON"` — `text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2`
- `"{cancellationReason}"` — `text-sm font-medium text-slate-900 italic mb-1`
- `"Category: {cancellationCategory}"` — `text-xs text-slate-400`

**Email history section (`px-6 mt-5`):**
- `"Email history"` — `text-sm font-semibold text-slate-900 mb-3`
- If no emails: `"No emails sent yet. Winback will send the first one automatically."` — `text-sm text-slate-400`
- If emails: list each with type badge + sent time. If `replied_at` set: show `"Replied: {date}"` in green.

**Actions section (`px-6 mt-5 pt-5 border-t border-slate-100`):**
```
Row 1: [↺ Resend]    [✓ Mark recovered]
Row 2: [🗑 Archive as lost]
```

- `"Resend"` — secondary outline button — `POST /api/subscribers/{id}/resend`
  Re-sends the exit email. Only show if status is not 'recovered' or 'lost'.
- `"Mark recovered"` — primary dark button — `POST /api/subscribers/{id}/recover`
  Sets `status = 'recovered'`, creates `wb_recoveries` row.
- `"Archive as lost"` — full-width secondary outline button — `POST /api/subscribers/{id}/archive`
  Sets `status = 'lost'`.

All three API routes: require auth, return `{ success: true }` on success.

---

## Definition of done
- [ ] `/dashboard` redirects to `/login` without session
- [ ] Page header with "Update changelog" button works (opens modal, saves)
- [ ] Billing alert banner shows only for trial users with ≥1 recovery
- [ ] Banner dismisses and stays dismissed (localStorage)
- [ ] All 4 stat cards show real data from API
- [ ] Filter tabs filter subscriber list correctly
- [ ] Search filters by name, email, cancellationReason (case-insensitive)
- [ ] Subscriber table shows all 6 columns with correct formatting
- [ ] Row click opens detail panel
- [ ] Detail panel shows all subscriber information
- [ ] All 3 action buttons call correct API routes and update UI on success
- [ ] Page matches live site visually

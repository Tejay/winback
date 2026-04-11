# Spec 06 — Settings Page

**Phase:** 6
**Depends on:** Spec 01 (TopNav), Spec 03 (OAuth routes)
**Reference:** https://churntool-jxgo.vercel.app/settings
**Estimated time:** 1.5 hours

---

## app/settings/page.tsx

Server component. Redirect to `/login` if no session.
Load `wb_customers` row to know which integrations are connected.

```tsx
<TopNav userName={session.user.name} />
<main className="min-h-screen bg-[#f5f5f5]">
  <div className="max-w-5xl mx-auto px-6 py-8">
```

---

## Page header

```
WORKSPACE

Settings.

Connections, plan, and the voice of your winback emails.
```

- `"WORKSPACE"` — blue section label
- `"Settings."` — `text-4xl font-bold text-slate-900` (trailing period)
- Subtitle — `text-sm text-slate-500 mt-1`

---

## Section 1 — Integrations

Card: `bg-white rounded-2xl border border-slate-100 shadow-sm p-6 mb-4`

```
INTEGRATIONS                       ← blue section label
Connected accounts                 ← text-lg font-semibold text-slate-900
These power Winback. Reconnect or disconnect at any time.   ← text-sm text-slate-500 mt-1 mb-6
```

**Stripe row** (`flex items-center justify-between py-4 border-b border-slate-100`):

Left (`flex items-center gap-4`):
- `bg-blue-600 rounded-xl w-10 h-10` square with white credit-card SVG icon
- `"Stripe"` — `text-sm font-medium text-slate-900`
- `"Receives cancellation webhooks"` — `text-xs text-slate-500`

Right:
- If NOT connected: `[⚠ Not connected]` badge + `[Connect]` button → `/api/stripe/connect`
  - Badge: `bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-2.5 py-0.5 text-xs font-medium`
- If connected: `[● Connected]` badge + `[Disconnect]` outline button
  - Badge: `bg-green-50 text-green-700 border border-green-200 rounded-full px-2.5 py-0.5 text-xs font-medium`

**Gmail row** (`flex items-center justify-between py-4`) — same structure as Stripe:

Left:
- Red envelope icon (`#EA4335`) on `bg-red-50 rounded-xl w-10 h-10`
- `"Gmail"` + `"Sends winback emails from your address"`

Right:
- Same connected/not-connected pattern. "Connect" → `/api/gmail/connect`

**Disconnect routes:**

`POST /api/stripe/disconnect`:
- Requires auth session
- Clears `stripe_account_id`, `stripe_access_token`, `stripe_webhook_secret` in `wb_customers`
- Returns `{ success: true }`

`POST /api/gmail/disconnect`:
- Requires auth session
- Clears `gmail_refresh_token`, `gmail_email` in `wb_customers`
- Returns `{ success: true }`

Both disconnect buttons show a confirmation dialog before calling the API. Page refreshes after disconnect.

**"Connected" is determined by:** `customer.stripeAccessToken !== null` and `customer.gmailRefreshToken !== null`

---

## Section 2 — Billing

Card: `bg-white rounded-2xl border border-slate-100 shadow-sm p-6`

```
BILLING                            ← blue section label
Subscription                       ← text-lg font-semibold text-slate-900
You only pay once Winback is actively recovering customers.  ← text-sm text-slate-500 mt-1 mb-6
```

**Plan card** (`bg-white border border-slate-200 rounded-2xl p-5`):

Top row (`flex items-start justify-between`):
- Left: `"CURRENT PLAN"` in `text-xs font-semibold uppercase tracking-widest text-slate-400`
  + `"🌟 Free trial"` badge in `bg-amber-50 text-amber-700 border border-amber-200 rounded-full px-3 py-1 text-xs font-semibold ml-2`
- Right: `"Add payment method"` primary dark button (placeholder for now — actual Stripe billing is post-MVP)

Middle:
- `"£49"` — `text-3xl font-bold text-slate-900`
- `"/ month"` — `text-slate-400` inline with the number
- `"+ 10% of recovered MRR for the first year each subscriber stays back."` — `text-sm text-slate-500 mt-2`

Bottom:
- `"First recovery always free · Cancel anytime"` — `text-xs text-slate-400 mt-3`

**Billing contact row** (`flex items-center justify-between py-4 border-t border-slate-100 mt-4`):
- Left: `"Billing contact"` (`text-sm font-medium text-slate-900`) + user's email below (`text-sm text-slate-500`)
- Right: `"Update"` outline button (placeholder — no action needed yet)

**Invoices row** (`flex items-center justify-between py-4 border-t border-slate-100`):
- Left: `"Invoices"` (`text-sm font-medium text-slate-900`) + `"None yet"` below (`text-sm text-slate-500`)
- Right: `"View history"` — `text-sm text-blue-600 hover:underline` (placeholder — no action needed)

---

## Definition of done
- [ ] `/settings` redirects to `/login` without session
- [ ] Page header matches live site
- [ ] Stripe row correctly shows "Not connected" or "Connected" based on database
- [ ] Gmail row correctly shows connection state
- [ ] "Connect" links go to correct OAuth routes
- [ ] Billing section shows plan card with all content
- [ ] Billing contact shows user's email from session
- [ ] Page matches https://churntool-jxgo.vercel.app/settings visually

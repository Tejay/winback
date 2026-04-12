# Spec 03 — Onboarding Flow (3 steps)

**Phase:** 3
**Depends on:** Spec 01 (auth + step-progress component), Spec 01 (Stripe routes)
**Reference:** /onboarding/stripe through /onboarding/review on live site
**Estimated time:** 3 hours
**Human checkpoints:** 2

---

## Shared layout for all onboarding pages

Every onboarding page must:
1. Redirect to `/login` if no auth session
2. Use this shell:

```
min-h-screen bg-[#f5f5f5]

Header (not sticky):
  px-6 py-5
  <Logo size="sm" />

Body:
  max-w-2xl mx-auto px-4 pb-12
  <StepProgress currentStep={N} completedSteps={[...]} />
  mt-6
  <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8">
    [step content]
  </div>
```

`completedSteps` is read from `wb_customers` — check which OAuth tokens are saved.

---

## Step 1 — /onboarding/stripe

**StepProgress:** `currentStep={1}` `completedSteps={[]}`

Inside white card:

**Step badge:**
`"STEP 1 OF 3"` — `bg-blue-50 text-blue-700 text-xs font-semibold rounded-full px-3 py-1 inline-block mb-4`

**Heading:**
`"Connect your Stripe account"` — `text-2xl font-bold text-slate-900 mb-2`

**Subtitle:**
`"One OAuth click gives Winback access to cancellation events. We never touch your customers' payment details."` — `text-sm text-slate-500 mb-6`

**Stripe integration card:**
`bg-slate-50 rounded-xl border border-slate-100 p-5 flex items-center justify-between`

Left side:
- Blue `rounded-xl bg-blue-600 w-10 h-10` square with white credit-card SVG
- `"Stripe"` — `text-sm font-medium text-slate-900`
- `"Subscription data & cancellation webhooks"` — `text-xs text-slate-500`

Right side:
- `"Connect Stripe"` — primary dark button → clicks trigger redirect to `GET /api/stripe/connect`

**Three trust points (below card):**
```
✓  Read-only access to subscriptions and customers
✓  Real-time webhook for customer.subscription.deleted
✓  Disconnect any time from Settings
```
Each: `flex items-center gap-2 text-sm text-slate-500 mt-3`
Checkmark: `text-blue-600 font-bold text-base`

**Navigation:**
`flex justify-end mt-8`
`"Next: Paste changelog →"` button — disabled/greyed if Stripe not yet connected, enabled dark button if connected.

**Stripe OAuth routes:**

`GET /api/stripe/connect`:
- Requires auth session
- Get or create `wb_customers` row for this user
- Build OAuth URL:
  ```
  https://connect.stripe.com/oauth/authorize
    ?response_type=code
    &client_id={STRIPE_CLIENT_ID}
    &scope=read_only
    &state={customer.id}
    &redirect_uri={NEXT_PUBLIC_APP_URL}/api/stripe/callback
  ```
- `NextResponse.redirect(url)`

`GET /api/stripe/callback?code=XXX&state=XXX`:
- If `error` param present → redirect to `/onboarding/stripe?error=denied`
- Verify `state` matches a `wb_customers.id`
- Exchange code: `POST https://connect.stripe.com/oauth/token` `grant_type=authorization_code code={code}`
- Encrypt access_token using `encryption.ts`
- Reconnect protection: if user already has a `stripeAccountId`, keep the original account ID (don't overwrite with new one from `read_write` OAuth which creates duplicate accounts)
- Save `stripe_account_id` (or keep existing) and encrypted `stripe_access_token` to `wb_customers`
- Redirect to `/onboarding/changelog`
- Note: scope is `read_write` (Stripe blocks `read_only` by default — contact support to enable before production)
- Note: webhook is NOT registered per-account. A single Connect webhook on the platform account handles all connected accounts (see Phase 8)

⛔ **CHECKPOINT — before testing OAuth:**
Show the redirect URI that will be used. Ask: "Is `{NEXT_PUBLIC_APP_URL}/api/stripe/callback` added as a Redirect URI in your Stripe Dashboard → Connect → Settings? Type 'yes' when done."

---

## Step 2 — /onboarding/changelog

**StepProgress:** `currentStep={2}` `completedSteps={[1]}`

Step 1 shows as completed.

Inside white card:

**Step badge:** `"STEP 2 OF 3"`

**Heading:** `"What have you shipped recently?"`

**Subtitle:** `"Paste a list of improvements. Winback uses this to write honest, specific winback messages — not generic discounts."`

**Textarea:**
```
min-h-[200px] w-full border border-slate-200 rounded-2xl p-4 text-sm
focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none
```

Placeholder text (grey, shown when empty):
```
e.g.
- Fixed the calendar sync bug that was duplicating events
- Rebuilt the mobile app from scratch — 3x faster
- Added CSV export for all reports
- New billing dashboard with usage breakdown
- Removed the 30-second load time on the projects page
```

**Hint below textarea:**
`"⚡ Bullet points work best. You can edit this any time in Settings."` — `text-xs text-slate-400 mt-2 flex items-center gap-1.5`

**Navigation:**
`"Back"` → `/onboarding/stripe`
`"Next: Review first email →"` — always enabled (changelog is optional)

On "Next": if textarea has content, `POST /api/changelog { content }`, then navigate to `/onboarding/review`.
If textarea is empty, navigate directly to `/onboarding/review`.

**`POST /api/changelog` (Phase 3 version — save only):**
- Requires auth session
- Body: `{ content: string }`
- Save to `wb_customers.changelog_text`
- Return `{ success: true }`
- Note: keyword extraction + win-back triggering is added in Phase 7

---

## Step 3 — /onboarding/review

**StepProgress:** `currentStep={3}` `completedSteps={[1, 2]}`

Both prior steps show as completed (green checks).

Inside white card:

**Step badge:** `"STEP 3 OF 3"`

**Heading:** `"Review the first winback email"`

**Subtitle:** `"This is what a real churned customer will receive, personalised to their cancellation reason."`

**Email preview card:**
`border border-slate-200 rounded-2xl overflow-hidden mt-6`

Header rows (each row: `flex justify-between items-center px-5 py-3 border-b border-slate-100 text-sm`):
```
From     | Founder Name via Winback <recover@winbackflow.co>
To       | sarah.k@gmail.com
Subject  | A quick update since you left
```

Body (`p-6 text-sm text-slate-700 leading-relaxed whitespace-pre-line`):
```
Hi Sarah,

You cancelled our app last week and mentioned small issues kept getting in the
way. That feedback stuck with us.

Here's what's changed since you left:

- (your recent improvements will appear here)

It's a much more reliable experience now. If you're open to it, I'd love for
you to take another look — no pressure, no trial reset.

— {user's name or email username}
```

If the user pasted a changelog in Step 3, replace `"(your recent improvements will appear here)"` with the actual changelog content.

**"Why this message?" card:**
`bg-blue-50 rounded-xl p-4 mt-4`
- `"Why this message?"` — `text-sm font-semibold text-blue-700 mb-1`
- `"Sarah left over quality issues — so we lead with accountability and show what changed. No discount, no pressure."` — `text-sm text-blue-600`

**Navigation:**
`"Back"` → `/onboarding/changelog`
`"Approve & enter dashboard →"` — primary dark button

On "Approve & enter dashboard":
1. `PATCH /api/customers/me` — set `onboarding_complete = true`
2. Redirect to `/dashboard`

**Fine print (below card):**
`"Your first recovery is free. After that: £49/mo + 10% of recovered MRR for the first year each subscriber stays back."` — `text-xs text-slate-400 text-center mt-4`

---

## Definition of done
- [ ] All 3 pages render with correct layout and copy
- [ ] Step progress bar shows correct active/completed states on each page
- [ ] All pages redirect to `/login` if unauthenticated
- [ ] Back buttons navigate correctly
- [ ] Next button disabled until step requirement met (step 1)
- [ ] Stripe OAuth saves encrypted token + redirects to step 2
- [ ] Changelog saves to database
- [ ] Step 3 shows email preview using Resend from address
- [ ] "Approve & enter dashboard" sets `onboarding_complete = true` + redirects to `/dashboard`
- [ ] Pages match live site visually

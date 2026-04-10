# Spec 03 — Onboarding Flow (4 steps)

**Phase:** 3
**Depends on:** Spec 01 (auth + step-progress component), Spec 01 (Stripe + Gmail routes)
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
`"STEP 1 OF 4"` — `bg-blue-50 text-blue-700 text-xs font-semibold rounded-full px-3 py-1 inline-block mb-4`

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
`"Next: Connect Gmail →"` button — disabled/greyed if Stripe not yet connected, enabled dark button if connected.

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
- Save `stripe_account_id` and encrypted `stripe_access_token` to `wb_customers`
- Redirect to `/onboarding/gmail`

⛔ **CHECKPOINT — before testing OAuth:**
Show the redirect URI that will be used. Ask: "Is `{NEXT_PUBLIC_APP_URL}/api/stripe/callback` added as a Redirect URI in your Stripe Dashboard → Connect → Settings? Type 'yes' when done."

---

## Step 2 — /onboarding/gmail

**StepProgress:** `currentStep={2}` `completedSteps={[1]}`

Step 1 shows as completed (green check in progress bar).

Inside white card — same structure as Step 1:

**Step badge:** `"STEP 2 OF 4"`

**Heading:** `"Connect Gmail to send winback emails"`

**Subtitle:** `"Emails go from your real address, not a generic no-reply. That's what gets replies."`

**Gmail integration card** (same layout as Stripe card):
- Red envelope icon on `bg-red-50 rounded-xl` (Gmail red: `#EA4335`)
- `"Gmail"` + `"Send from your own address via OAuth"`
- `"Connect Gmail"` primary button

**Three trust points:**
```
✓  Send only — we never read your inbox
✓  Replies land directly in your real inbox
✓  Revoke access in Google anytime
```

**Navigation:**
`"Back"` secondary button → `/onboarding/stripe`
`"Next: Paste changelog →"` — greyed until Gmail connected, dark when connected

**Gmail OAuth routes:**

⛔ **CHECKPOINT — before building Gmail routes:**
Output these exact instructions:
```
To set up Gmail OAuth:
1. Go to console.cloud.google.com
2. Create new project → name it "winback"
3. APIs & Services → Library → search "Gmail API" → Enable
4. APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
   Application type: Web application
   Authorised redirect URI: http://localhost:3000/api/gmail/callback
5. Copy Client ID and Client Secret → add to .env.local as GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET
6. OAuth consent screen → Test users → add your own email address
Tell me when this is done.
```
**Wait for human confirmation before writing the Gmail routes.**

`GET /api/gmail/connect`:
- Requires auth
- Scopes: `gmail.send` + `gmail.modify`
- `access_type: 'offline'`, `prompt: 'consent'` (ensures refresh token is returned)
- State: `customer.id`
- Redirect to Google OAuth URL

`GET /api/gmail/callback?code=XXX&state=XXX`:
- Exchange code: `POST https://oauth2.googleapis.com/token`
- Get Gmail email from: `GET https://www.googleapis.com/userinfo/v2/me`
- Encrypt refresh_token using `encryption.ts`
- Save encrypted `gmail_refresh_token` and `gmail_email` to `wb_customers`
- Redirect to `/onboarding/changelog`

---

## Step 3 — /onboarding/changelog

**StepProgress:** `currentStep={3}` `completedSteps={[1, 2]}`

Steps 1 and 2 show as completed.

Inside white card:

**Step badge:** `"STEP 3 OF 4"`

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
`"Back"` → `/onboarding/gmail`
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

## Step 4 — /onboarding/review

**StepProgress:** `currentStep={4}` `completedSteps={[1, 2, 3]}`

All three prior steps show as completed (green checks).

Inside white card:

**Step badge:** `"STEP 4 OF 4"`

**Heading:** `"Review the first winback email"`

**Subtitle:** `"This is what a real churned customer will receive, personalised to their cancellation reason."`

**Email preview card:**
`border border-slate-200 rounded-2xl overflow-hidden mt-6`

Header rows (each row: `flex justify-between items-center px-5 py-3 border-b border-slate-100 text-sm`):
```
From     | {user's gmail_email — or placeholder "you@yourdomain.com"}
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
- [ ] All 4 pages render with correct layout and copy
- [ ] Step progress bar shows correct active/completed states on each page
- [ ] All pages redirect to `/login` if unauthenticated
- [ ] Back buttons navigate correctly
- [ ] Next buttons disabled until step requirement met (steps 1 and 2)
- [ ] Stripe OAuth saves encrypted token + redirects to step 2
- [ ] Gmail OAuth saves encrypted refresh token + gmail email + redirects to step 3
- [ ] Changelog saves to database
- [ ] Step 4 shows email preview using user's real Gmail address
- [ ] "Approve & enter dashboard" sets `onboarding_complete = true` + redirects to `/dashboard`
- [ ] Pages match live site visually

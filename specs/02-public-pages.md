# Spec 02 — Public Pages (Landing, Login, Register)

**Phase:** 2
**Depends on:** Spec 01 (components/logo.tsx must exist)
**Reference:** https://churntool-jxgo.vercel.app (no login needed)
**Estimated time:** 2 hours

---

## Landing page — app/page.tsx

Four sections. Match https://churntool-jxgo.vercel.app exactly.

### Section 1 — Navigation
Full-width white bar.

```
[Logo]    [How it works]  [Log in]  [Sign up →]
```

- `Logo` component linking to `"/"`
- `"How it works"` — `<a href="#how-it-works">` text-slate-600 text-sm
- `"Log in"` — `<Link href="/login">` text-slate-600 text-sm
- `"Sign up"` — `<Link href="/register">` primary dark button

---

### Section 2 — Hero
`bg-[#eef2fb]` background. `py-24`. All content centred.

Top to bottom:

**Badge:**
```
NEW · AI CHURN RECOVERY
```
`bg-white border border-slate-200 rounded-full px-4 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-widest`

**Headline (two lines):**
```
Win back churn.
Automatically.
```
Line 1: `text-6xl font-bold text-slate-900 text-center`
Line 2: `text-6xl font-bold text-blue-600 text-center`

**Subtext:**
```
The moment a customer cancels, Winback sends a personalised
email — grounded in what you've delivered recently, their
subscription history, and any reason they shared for leaving.
```
`text-lg text-slate-500 max-w-2xl text-center leading-relaxed`

**Button row:**
```
[Get started →]    [How it works ›]
```
- "Get started →" → primary dark button → `/register`
- "How it works ›" → `text-blue-600 font-medium text-sm`

**Pricing note:**
```
Free first recovery. Then £49/mo + 10% of what we win back.
```
`text-sm text-slate-400 text-center`

**Demo card** (`bg-white rounded-2xl shadow-sm border border-slate-100 p-6 max-w-lg mx-auto mt-12`):

Top block:
- `STRIPE EVENT` in `text-xs font-semibold uppercase tracking-widest text-blue-600 mb-1`
- `customer.subscription.deleted` in `font-mono font-bold text-slate-900 text-sm`
- `Sarah K. · Pro · $24.99/mo` in `text-xs text-slate-500 mt-1`
- Blue lightning bolt icon in a `bg-slate-100 rounded-xl w-9 h-9` circle, right-aligned

Bottom block (`bg-green-50 rounded-xl p-3 mt-4 flex items-center gap-2`):
- Green check circle icon
- `Winback email sent · Resubscribed in 2 days` in `text-sm font-medium text-green-700`

---

### Section 3 — How it works
`id="how-it-works"` `bg-white` `py-24`

**Section header (centred):**
- `How it works` — blue section label
- `Three steps.` — `text-4xl font-bold text-slate-900`
- `Zero manual work.` — `text-4xl font-bold text-slate-900`
- Subtitle: `"From cancellation to recovery in under a minute — without you touching a thing."` — `text-lg text-slate-500 mt-4 max-w-2xl text-center`

**Three step cards** — `grid grid-cols-1 md:grid-cols-3 gap-8 mt-16 max-w-5xl mx-auto`

Each card: `bg-white` with step number, title, description, demo card insert.

**Step 01 — Detect Every cancellation. Instantly.**
Body: "One OAuth click connects Stripe. From then on, every subscription.deleted event flows in the moment it happens — with the customer, the MRR, the plan, and the reason they gave."

Demo card insert shows: STRIPE EVENT box with Customer / Plan / Tenure / "Received 0.4 seconds ago"

**Step 02 — Decide The right message. For the right reason.**
Body: "Winback reads each cancellation reason and picks the response that matches — accountability when it's a quality issue, education when they missed a feature, a genuine update when things have changed."

Demo card shows: Cancellation reason + "Winback chooses" section with Tone / Content / Channel fields

**Step 03 — Act Sent automatically. From your real inbox.**
Body: "Emails go from your own Gmail, signed with your name. No generic no-reply. Replies come straight back to you — which is what turns a winback into a conversation."

Demo card shows: Email preview (From / To / Subject / abbreviated body)

---

### Section 4 — Footer CTA
`bg-[#eef2fb]` `py-24` centred

```
Ready to recover?                       ← blue section label
Connect Stripe in two clicks.
Your first recovery is on us.           ← text-4xl font-bold text-slate-900

[Get started]                           ← primary dark button → /register

Free until your first recovery.
Then £49/mo + 10% of recovered revenue  ← text-sm text-slate-400 text-center
— first year each subscriber stays back.
No card required.
```

---

## Login page — app/login/page.tsx

```
min-h-screen bg-[#f5f5f5] flex flex-col items-center
<Logo size="md" /> — mt-12 mb-8
<div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-100 p-8">
```

Inside card:

**Heading:**
- `"Welcome back."` — `text-2xl font-bold text-slate-900 mb-1`
- `"Let's recover some revenue."` — `text-sm text-slate-500 mb-8`

**Form fields:**
```
EMAIL
[you@company.com]              ← rounded-full input

PASSWORD
[••••••••]                     ← rounded-full input type="password"

[Log in →]                     ← primary button full-width
```

**Error message** (shows below button if login fails):
`text-sm text-red-600 text-center mt-2`

**Footer:**
`"Don't have an account?"` + `"Sign up"` blue link → `/register`
`text-sm text-slate-500 text-center mt-6`

**Form behaviour:**
```typescript
import { signIn } from 'next-auth/react'
await signIn('credentials', { email, password, callbackUrl: '/dashboard' })
```
Show loading state on button while submitting.

---

## Register page — app/register/page.tsx

Same page shell as login (`min-h-screen bg-[#f5f5f5]`, centred Logo, centred card).

Inside card:

**Heading:**
- `"Create your account."` — `text-2xl font-bold text-slate-900 mb-1`
- `"Connect Stripe and start recovering churn in under 5 minutes."` — `text-sm text-slate-500 mb-8`

**Form fields:**
```
YOUR NAME
[Alex Founder]

WORK EMAIL
[you@company.com]

PASSWORD
[At least 8 characters]

[Create account →]             ← primary button full-width
```

Below button:
`"Free until your first recovery. No card required."` — `text-xs text-blue-600 text-center mt-2`

**Footer:**
`"Already have an account?"` + `"Log in"` blue link → `/login`
`text-sm text-slate-500 text-center mt-6`

**Form behaviour:**
1. Client-side validate: name not empty, email valid, password ≥ 8 chars
2. `POST /api/auth/register` with `{ name, email, password }`
3. 201 → redirect to `/login`
4. 409 → show inline error: `"An account with this email already exists."`
5. Loading state on button during request

---

## Definition of done
- [ ] Landing page renders — matches https://churntool-jxgo.vercel.app visually
- [ ] All 4 landing sections present and correct
- [ ] "Get started" / "Sign up" both go to `/register`
- [ ] Landing is mobile responsive
- [ ] `/login` renders — matches live site
- [ ] Login submits and redirects to `/dashboard` on success
- [ ] Login shows error on wrong credentials
- [ ] `/register` renders — matches live site
- [ ] Register creates user and redirects to `/login`
- [ ] Register shows error on duplicate email

# TASKS — Winback Build Sequence

Work through in order. Check off each item. Do not skip ahead.
Read the corresponding spec file before starting each phase.

---

## Phase 1 — Foundation
**Spec: specs/01-database-auth.md**

### Task 1.1 — Audit existing project
- [ ] Run `ls -la` and show full file tree
- [ ] Read `package.json` — list every installed package
- [ ] Read `tsconfig.json` — note path aliases (e.g. `@/`)
- [ ] Check if `components/ui` exists (shadcn already initialised?)
- [ ] List any existing pages in `app/`

⛔ **STOP — report all findings to human before writing any code**

### Task 1.2 — Install packages
Show human this full list before installing:
```
drizzle-orm              ORM core
@neondatabase/serverless  Neon Postgres driver
drizzle-kit              Migration CLI (devDependency)
next-auth@beta           Auth
@auth/drizzle-adapter    NextAuth Drizzle adapter
bcryptjs                 Password hashing
@types/bcryptjs
stripe                   Stripe SDK
@anthropic-ai/sdk        Claude API
googleapis               Gmail API
zod                      Validation
swr                      Data fetching
@types/node
vitest                   Tests (devDependency)
@vitejs/plugin-react     (devDependency)
```
⛔ **STOP — wait for human approval before running `npm install`**

### Task 1.3 — Environment setup
Create `env.example` (NOT `.env.local`). Output this to human:
```
Add a Neon database:
  Go to vercel.com → your project → Storage tab → Create Database → Neon
  Then run: vercel env pull .env.local
  This sets DATABASE_URL automatically.

Also add to .env.local:
  NEXTAUTH_SECRET=<run: openssl rand -base64 32>
  NEXTAUTH_URL=http://localhost:3000
  ENCRYPTION_KEY=<run: openssl rand -hex 16>
  CRON_SECRET=<any random string>

Tell me when .env.local has DATABASE_URL set.
```
⛔ **STOP — wait for confirmation that DATABASE_URL is in .env.local**

### Task 1.4 — Database schema + migration
- [ ] Create `lib/db.ts` — Neon + Drizzle connection
- [ ] Create `lib/schema.ts` — all 5 table definitions
- [ ] Create `src/winback/migrations/001_initial.sql`
- [ ] Create `src/winback/lib/types.ts`

⛔ **STOP — show migration SQL to human, wait for "yes" before running**

- [ ] Run migration after approval
- [ ] Verify: `psql $DATABASE_URL -c "\dt wb_*"` shows 5 tables
- [ ] `npx tsc --noEmit` → zero errors

### Task 1.5 — Authentication
- [ ] Create `lib/auth.ts` — NextAuth config
- [ ] Create `app/api/auth/[...nextauth]/route.ts`
- [ ] Create `app/api/auth/register/route.ts`
- [ ] Create `types/next-auth.d.ts`
- [ ] `npx tsc --noEmit` → zero errors

### Task 1.6 — Shared UI components
- [ ] Install shadcn: `npx shadcn@latest add button card badge table input label textarea dialog`
- [ ] Create `components/logo.tsx`
- [ ] Create `components/status-badge.tsx`
- [ ] Create `components/top-nav.tsx`
- [ ] Create `components/step-progress.tsx`

---

## Phase 2 — Public pages
**Spec: specs/02-public-pages.md**

### Task 2.1 — Landing page
- [ ] Create `app/page.tsx`
- [ ] Run dev server → confirm it visually matches https://churntool-jxgo.vercel.app

### Task 2.2 — Login page
- [ ] Create `app/login/page.tsx`
- [ ] Test: submit correct credentials → redirects to `/dashboard`
- [ ] Test: wrong credentials → shows error

### Task 2.3 — Register page
- [ ] Create `app/register/page.tsx`
- [ ] Test: submit form → user created → redirects to `/login`
- [ ] Test: duplicate email → shows error

---

## Phase 3 — Onboarding
**Spec: specs/03-onboarding.md**

### Task 3.1 — Step 1: Connect Stripe
- [ ] Create `app/onboarding/stripe/page.tsx`
- [ ] Create `app/api/stripe/connect/route.ts`
- [ ] Create `app/api/stripe/callback/route.ts`

⛔ **STOP — "Is `{NEXT_PUBLIC_APP_URL}/api/stripe/callback` configured in your Stripe Dashboard → Connect → Redirect URIs? Type 'yes' when done."**

### Task 3.2 — Step 2: Connect Gmail
- [ ] Create `app/onboarding/gmail/page.tsx`

⛔ **STOP — output Google Cloud Console setup instructions, wait for confirmation**

- [ ] Create `app/api/gmail/connect/route.ts`
- [ ] Create `app/api/gmail/callback/route.ts`

### Task 3.3 — Step 3: Changelog
- [ ] Create `app/onboarding/changelog/page.tsx`
- [ ] Create `app/api/changelog/route.ts` (save only — keyword matching added in Phase 7)

### Task 3.4 — Step 4: Review email
- [ ] Create `app/onboarding/review/page.tsx`
- [ ] "Approve & enter dashboard →" sets `onboarding_complete = true` + redirects to `/dashboard`

---

## Phase 4 — Core engine
**Spec: specs/04-core-engine.md**

### Task 4.1 — Encryption
- [ ] Create `src/winback/lib/encryption.ts`
- [ ] Tests: encrypt→decrypt round-trip, different ciphertext same input, bad key throws

### Task 4.2 — Stripe webhook + signal extraction
- [ ] Create `src/winback/lib/stripe.ts` (`extractSignals` function)
- [ ] Create `app/api/stripe/webhook/route.ts` (raw body, idempotent)
- [ ] Create test fixtures in `src/winback/__tests__/fixtures/`
- [ ] All 6 webhook tests passing

⛔ **STOP — "Run: `stripe listen --forward-to localhost:3000/api/stripe/webhook`. Paste the webhook secret to .env.local as STRIPE_WEBHOOK_SECRET. Tell me when done."**

- [ ] Test with `stripe trigger customer.subscription.deleted`
- [ ] Confirm row appears in `wb_churned_subscribers`

### Task 4.3 — LLM classifier
- [ ] Create `src/winback/lib/classifier.ts` with Zod output schema
- [ ] All 5 mocked test scenarios passing

⛔ **STOP — "All mocked tests pass. One live Anthropic API call will cost ~$0.003. Type 'yes' to proceed."**

- [ ] Run one live test → confirm output passes Zod validation

### Task 4.4 — Gmail email sender
- [ ] Create `src/winback/lib/email.ts` (`sendEmail`, `scheduleExitEmail`)
- [ ] Tests passing with mocked Gmail API

⛔ **STOP — "Ready to send one test email to your address to verify Gmail works. Type 'yes'."**

- [ ] Confirm human received the email

### Task 4.5 — Reply polling
- [ ] Create `src/winback/lib/reply.ts`
- [ ] Create `app/api/gmail/reply-poll/route.ts` (secured with CRON_SECRET)
- [ ] Create `vercel.json` with 5-minute cron schedule
- [ ] Tests passing

---

## Phase 5 — Dashboard
**Spec: specs/05-dashboard.md**

### Task 5.1 — API endpoints
- [ ] Create `app/api/stats/route.ts` → returns 4 stats
- [ ] Create `app/api/subscribers/route.ts` → paginated list with filter + search
- [ ] Both return 401 without valid session

### Task 5.2 — Dashboard page
- [ ] Create `app/dashboard/page.tsx`
- [ ] Page header + "Update changelog" button
- [ ] Billing alert banner (trial users with ≥1 recovery)
- [ ] 4 stat cards
- [ ] Filter tabs + search bar
- [ ] Subscriber table (6 columns)

### Task 5.3 — Subscriber detail panel
- [ ] Slide-in panel from right on row click
- [ ] All subscriber info, email history, 3 action buttons
- [ ] Create `POST /api/subscribers/[id]/resend`
- [ ] Create `POST /api/subscribers/[id]/recover`
- [ ] Create `POST /api/subscribers/[id]/archive`

---

## Phase 6 — Settings
**Spec: specs/06-settings.md**

### Task 6.1 — Settings page
- [ ] Create `app/settings/page.tsx`
- [ ] Integrations section (Stripe + Gmail cards with live connection status)
- [ ] Billing section (plan card + billing contact + invoices)

---

## Phase 7 — Billing + changelog trigger
**Spec: specs/07-billing.md**

### Task 7.1 — Changelog keyword trigger
- [ ] Update `app/api/changelog/route.ts` — LLM keyword extraction + subscriber matching + win-back send

⛔ **STOP — "End-to-end test will send one real email. Type 'yes'."**

### Task 7.2 — Fee calculation
- [ ] Create `src/winback/lib/billing.ts`
- [ ] Create `app/api/billing/preview/route.ts`
- [ ] Tests passing

⛔ **STOP — show billing formula example, wait for "yes" confirmation**

---

## Phase 8 — Launch prep

### Task 8.1 — Historical seeding
- [ ] On Stripe OAuth callback: fetch last 90 days churned (max 500), classify all, populate dashboard

### Task 8.2 — Route protection audit
- [ ] `/dashboard` and `/onboarding/*` → redirect to `/login` if no session
- [ ] After login: redirect to `/onboarding/stripe` if Stripe not connected
- [ ] After Stripe + Gmail connected: redirect to `/dashboard`

### Task 8.2b — Connect webhook setup
- [ ] Register one Connect webhook on the platform Stripe account:
  ```
  POST /v1/webhook_endpoints
    connect=true
    url={NEXT_PUBLIC_APP_URL}/api/stripe/webhook
    enabled_events[]=customer.subscription.deleted
    enabled_events[]=customer.subscription.created
  ```
- [ ] Save the returned `secret` as `STRIPE_WEBHOOK_SECRET` in env vars
- [ ] For local dev: use ngrok URL. For production: use Vercel domain.

### Task 8.3 — Final checks
- [ ] `npx tsc --noEmit` → zero errors
- [ ] `npm test` → all passing
- [ ] `.env.local` in `.gitignore`
- [ ] `env.example` committed
- [ ] `vercel.json` committed
- [ ] No hardcoded secrets anywhere

⛔ **STOP — final human review before declaring done**

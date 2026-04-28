# Winback — Claude Code Project Context

## What this project is

Winback is a SaaS that helps subscription businesses automatically recover churned customers.
The moment a subscriber cancels on Stripe, Winback sends a personalised plain-text email via
Resend within 60 seconds. An LLM classifies why they left and generates a
targeted win-back message. When the product ships something matching their stated reason, the
win-back fires automatically.

**Pricing:** Flat **$99/mo platform fee** covering unlimited card-save (failed payment)
emails, plus a one-time **1× MRR performance fee** per voluntary-cancellation win-back,
refundable in full if the subscriber re-cancels within 14 days. No card at signup —
billing starts on the first delivered save or win-back, whichever comes first.
Implemented as a Stripe Subscription on Winback's own Stripe account.

**Live reference site:** https://churntool-jxgo.vercel.app
Every UI decision must match this site exactly unless specified otherwise.

---

## Project state

Fresh Next.js 14 App Router project. It has Tailwind CSS, TypeScript, and shadcn/ui initialised.

It does NOT have:
- Database or database connection
- Authentication
- API routes
- Server-side code
- Environment variables

Build the entire backend from scratch.

---

## Tech stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | Next.js 14 App Router | Pages + API in one repo |
| Database | Neon (serverless Postgres) | Add via Vercel Storage tab — sets DATABASE_URL automatically |
| ORM | Drizzle ORM | SQL-like, TypeScript-native |
| Auth | NextAuth v5 | JWT sessions, credentials provider |
| Stripe | Stripe SDK + Stripe OAuth | OAuth reads customer's Stripe data read-only |
| LLM | Anthropic SDK, claude-haiku-4-5-20251001 | ~$0.003/call |
| Email | Resend | Reliable transactional email with inbound webhooks |
| Validation | Zod | All external data validated before use |
| UI | shadcn/ui + Tailwind CSS | Match live site |
| Testing | Vitest | Unit tests for all lib modules |
| Hosting | Vercel | git push deploys, built-in cron jobs |

---

## Design system — match the live site exactly

### Colours
```
Page background:  #f5f5f5
Card/surface:     #ffffff
Top nav:          #ffffff  border-b border-slate-100
Primary text:     #0f172a
Secondary text:   #64748b
Muted text:       #94a3b8
Blue accent:      #3b82f6
Section labels:   #3b82f6  text-xs font-semibold uppercase tracking-widest
Dark button:      bg-[#0f172a] text-white hover:bg-[#1e293b]
Border:           #e2e8f0
Recovered badge:  bg-green-50 text-green-700 border border-green-200
Contacted badge:  bg-blue-50  text-blue-700  border border-blue-200
Pending badge:    bg-amber-50 text-amber-700 border border-amber-200
Lost badge:       bg-slate-100 text-slate-500 border border-slate-200
```

### Typography
```
Section label:  text-xs font-semibold tracking-widest uppercase text-blue-600
Page title:     text-4xl font-bold text-slate-900
                Always has a trailing period — "Dashboard." / "Settings." / "Register."
Page subtitle:  text-sm text-slate-500
Table header:   text-xs font-semibold uppercase tracking-wide text-slate-400
Body text:      text-sm text-slate-600
```

### Page layout templates
```
Auth pages (login, register):
  min-h-screen bg-[#f5f5f5]
  Logo centred, mt-12 mb-8
  max-w-sm mx-auto bg-white rounded-2xl shadow-sm border border-slate-100 p-8

Onboarding pages:
  min-h-screen bg-[#f5f5f5]
  Logo top-left, py-5 px-6
  max-w-2xl mx-auto — step progress bar, then white card rounded-2xl p-8

Dashboard / Settings:
  Sticky white top nav
  min-h-screen bg-[#f5f5f5]
  max-w-5xl mx-auto px-6 py-8
```

### Logo
Blue rounded-xl square with white lightning bolt SVG. "Winback" in font-semibold text-slate-900 beside it.

### Buttons
```
Primary:   bg-[#0f172a] text-white rounded-full px-5 py-2 text-sm font-medium
Secondary: border border-slate-200 bg-white text-slate-700 rounded-full px-5 py-2 text-sm font-medium
Disabled:  bg-slate-200 text-slate-400 rounded-full px-5 py-2 text-sm font-medium cursor-not-allowed
```

### Inputs
```
border border-slate-200 rounded-full px-4 py-2.5 text-sm w-full
focus:outline-none focus:ring-2 focus:ring-blue-500
Labels: block text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1.5
```

### Status badges
```
All:       inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium
Recovered: bg-green-50 text-green-700 border border-green-200 — icon: ✓
Contacted: bg-blue-50  text-blue-700  border border-blue-200  — icon: ✉
Pending:   bg-amber-50 text-amber-700 border border-amber-200 — icon: ○
Lost:      bg-slate-100 text-slate-500 border border-slate-200 — icon: ×
```

---

## File structure to build

```
app/
  page.tsx                         Landing page
  login/page.tsx
  register/page.tsx
  onboarding/
    stripe/page.tsx
    changelog/page.tsx
    review/page.tsx
  dashboard/page.tsx
  settings/page.tsx
  api/
    auth/[...nextauth]/route.ts
    auth/register/route.ts
    stripe/webhook/route.ts
    stripe/connect/route.ts
    stripe/callback/route.ts
    email/inbound/route.ts
    changelog/route.ts
    subscribers/route.ts
    stats/route.ts
    billing/preview/route.ts

components/
  logo.tsx
  status-badge.tsx
  top-nav.tsx
  step-progress.tsx

lib/
  db.ts
  auth.ts
  schema.ts

src/winback/
  lib/
    stripe.ts
    classifier.ts
    email.ts
    reply.ts
    encryption.ts
    billing.ts
    types.ts
  hooks/
    useWinbackData.ts
  __tests__/
    fixtures/
    classifier.test.ts
    email.test.ts
    billing.test.ts
  migrations/
    001_initial.sql

vercel.json
```

---

## Non-negotiable rules

### 🌿 Branch & merge discipline — every feature
**Every feature MUST be built on its own branch and fully tested before merge.
No direct commits to `main`. No exceptions.**

The flow for any feature, bugfix, or non-trivial change:

1. **Branch first**, before writing any code:
   ```bash
   git checkout -b feat/<short-name>          # or fix/, chore/, refactor/
   ```
2. **Commit on the branch only.** Never commit directly to `main`.
3. **Full verification before merge** — all of these must pass *and be shown
   to the human*:
   - [ ] `npx tsc --noEmit` — clean
   - [ ] `npx vitest run` — all tests green
   - [ ] **Dev server running** (`npm run dev`) and the new UI clicked through
         end-to-end by the human. Unit tests do not substitute for this.
   - [ ] For API routes: hit them with `curl` or the real UI path and verify
         the expected DB side-effects (query Neon with `psql` if destructive).
   - [ ] For migrations: applied to Neon *before* merging any code that depends
         on the new column/table.
4. **Open a PR**, even for solo work — it's the audit trail. Use `gh pr create`.
5. **Merge only after the human says "merge"** — Claude never self-merges.
6. **Delete the branch locally + remotely after merge.**

Exceptions — changes that may go direct to `main` without a branch:
- Docs-only edits (README, CLAUDE.md, TASKS.md, specs/*.md)
- Comment-only tweaks with no behaviour change

If it touches runtime code, a schema, an API, or UI: **branch**.

### ⛔ Always stop and ask before:
1. Running database migrations — show full SQL, wait for "yes"
2. Any live Anthropic API call — state cost (~$0.003), wait for "yes"
3. Installing npm packages — list all packages with reason, wait for "yes"
4. Committing or pushing to git
5. Merging a PR — run `npx tsc --noEmit`, `npx vitest run`, AND walk the human
   through the new behaviour on a running dev server. Show all results before
   merging. No merge without passing tests + human click-through.

### ✅ Always do without asking:
1. Write tests alongside every lib module in `src/winback/__tests__/`
2. Validate all external inputs with Zod before use
3. Idempotency checks on all webhook handlers
4. Store money as integers (cents/pence) — never floats
5. When adding Vercel env vars via CLI, ALWAYS use `printf` — never `echo`:
   ```bash
   # Correct — no trailing newline
   printf "%s" "value" | vercel env add NAME production
   # WRONG — echo adds \n which corrupts API keys and URLs
   echo "value" | vercel env add NAME production
   ```
6. Secrets via environment variables — never hardcoded
7. TypeScript strict mode — no implicit `any`
8. **Serverless-safe initialization** — NEVER instantiate SDK clients or validate env vars at module load time. Always use lazy initialization inside functions:
   ```typescript
   // WRONG — crashes build if env var missing
   const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
   const KEY = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex')
   if (KEY.length !== 16) throw new Error('...')

   // CORRECT — only runs when function is called
   function getStripe() { return new Stripe(process.env.STRIPE_SECRET_KEY!) }
   function getKey() {
     const key = Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex')
     if (key.length !== 16) throw new Error('...')
     return key
   }
   ```
   This is critical because:
   - Vercel imports all route modules at build time to collect page data
   - Preview deployments may not have all env vars set
   - Module-level throws crash the entire build, not just the affected route
9. **Vercel environment parity** — when adding env vars for production, ALWAYS also add them for preview. Preview deployments need all env vars to build and run:
   ```bash
   # Add for production
   printf "%s" "value" | vercel env add NAME production
   # ALSO add for preview (requires branch name)
   printf "%s" "value" | vercel env add NAME preview feature/branch-name
   ```
   URL-based vars (NEXTAUTH_URL, NEXT_PUBLIC_APP_URL) differ per environment:
   - Production: `https://winbackflow.co`
   - Preview: `https://winback-git-{branch}-....vercel.app`
   - Local dev: `https://tejay.ngrok.app` — the stable hobby-tier ngrok URL
     fronting `localhost:3000`. Started with
     `ngrok http --url=tejay.ngrok.app 3000`. Use this (NOT `localhost:3000`)
     for both env vars in `.env.local` so reset-email links, Stripe OAuth
     redirects, and webhook callbacks all resolve to a publicly reachable
     host. Restart `npm run dev` after changing either var — Next.js won't
     pick up `.env.local` edits via Fast Refresh.

### Auth pattern — use in every protected route and page

API route:
```typescript
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'

const session = await getServerSession(authOptions)
if (!session?.user?.id) {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}
const userId = session.user.id
```

Page (server component):
```typescript
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { redirect } from 'next/navigation'

const session = await getServerSession(authOptions)
if (!session) redirect('/login')
```

---

## Environment variables (none exist yet)

Tell the human which variables to add at each phase. Never create `.env.local` yourself.

```
# Phase 1 — set these first
DATABASE_URL=          # from Neon via Vercel Storage — auto-populated
NEXTAUTH_SECRET=       # openssl rand -base64 32
NEXTAUTH_URL=http://localhost:3000  # Browser-facing URL — used for all browser redirects after OAuth
ENCRYPTION_KEY=        # openssl rand -hex 16  ← must be exactly 32 hex chars
CRON_SECRET=           # any random string

# Phase 3 — Stripe
STRIPE_CLIENT_ID=      # Stripe Dashboard → Connect → OAuth tab → Test client ID
STRIPE_SECRET_KEY=     # sk_test_... (Winback's own Stripe account — drives platform billing)
STRIPE_WEBHOOK_SECRET= # From the Connect webhook registered on the platform account (connect=true)
STRIPE_PLATFORM_FEE_PRICE_ID=  # Optional. The Price ID for the $99/mo platform subscription.
                       # If unset, src/winback/lib/subscription.ts looks up by lookup_key
                       # 'winback_platform_monthly_v1' and creates the Product+Price on demand.
                       # Set this in production for cleaner Stripe-dashboard auditing.

# Phase 4 — Anthropic + Email
ANTHROPIC_API_KEY=
RESEND_API_KEY=

NEXT_PUBLIC_APP_URL=http://localhost:3000  # Must be publicly accessible (ngrok in dev, Vercel domain in prod) — used for Stripe OAuth redirect_uri and webhook endpoint
```

---

## How to start each session

Say: "Read CLAUDE.md and TASKS.md. Work through the next unchecked task."

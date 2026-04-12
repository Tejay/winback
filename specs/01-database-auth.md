# Spec 01 — Database + Auth Foundation

**Phase:** 1
**Depends on:** Nothing — do this first
**Estimated time:** 2 hours
**Human checkpoints:** 2

---

## Step 1 — lib/db.ts

Connect to Neon using the serverless driver + Drizzle ORM:

```typescript
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set')
}

const sql = neon(process.env.DATABASE_URL)
export const db = drizzle(sql, { schema })
```

---

## Step 2 — lib/schema.ts

Five tables. Use Drizzle ORM column helpers:

```typescript
import { pgTable, uuid, text, integer, boolean, decimal, timestamp } from 'drizzle-orm/pg-core'

// Winback accounts (one per founder using the product)
export const users = pgTable('wb_users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name:         text('name'),
  createdAt:    timestamp('created_at').defaultNow(),
})

// Per-user config: OAuth tokens, changelog, onboarding state
export const customers = pgTable('wb_customers', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  userId:             uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  stripeAccountId:    text('stripe_account_id'),
  stripeAccessToken:  text('stripe_access_token'),   // AES-256-GCM encrypted
  gmailRefreshToken:  text('gmail_refresh_token'),   // Legacy — kept for migration. Resend replaces Gmail OAuth
  gmailEmail:         text('gmail_email'),           // Legacy — kept for migration. Resend replaces Gmail OAuth
  founderName:        text('founder_name'),
  productName:        text('product_name'),
  changelogText:      text('changelog_text'),
  onboardingComplete: boolean('onboarding_complete').default(false),
  plan:               text('plan').default('trial'),
  createdAt:          timestamp('created_at').defaultNow(),
  updatedAt:          timestamp('updated_at').defaultNow(),
})

// Every churned subscriber from the customer's Stripe account
export const churnedSubscribers = pgTable('wb_churned_subscribers', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  customerId:           uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  stripeCustomerId:     text('stripe_customer_id').notNull(),
  email:                text('email'),
  name:                 text('name'),
  planName:             text('plan_name'),
  mrrCents:             integer('mrr_cents').notNull().default(0),  // always integers, never floats
  tenureDays:           integer('tenure_days'),
  everUpgraded:         boolean('ever_upgraded').default(false),
  nearRenewal:          boolean('near_renewal').default(false),     // cancelled within 3 days of renewal
  paymentFailures:      integer('payment_failures').default(0),
  previousSubs:         integer('previous_subs').default(0),
  stripeEnum:           text('stripe_enum'),             // too_expensive|missing_features|unused|switched_to_competitor|other
  stripeComment:        text('stripe_comment'),          // free-text from Stripe cancellation dialog
  replyText:            text('reply_text'),              // free-text from email reply
  cancellationReason:   text('cancellation_reason'),    // human-readable, shown in dashboard table
  cancellationCategory: text('cancellation_category'),  // Competitor|Price|Quality|Unused|Feature|Other
  tier:                 integer('tier'),                 // 1|2|3|4
  confidence:           decimal('confidence', { precision: 3, scale: 2 }),
  triggerKeyword:       text('trigger_keyword'),         // keyword to watch for in future changelogs
  winBackSubject:       text('win_back_subject'),
  winBackBody:          text('win_back_body'),
  status:               text('status').default('pending'), // pending|contacted|recovered|lost
  cancelledAt:          timestamp('cancelled_at'),
  createdAt:            timestamp('created_at').defaultNow(),
  updatedAt:            timestamp('updated_at').defaultNow(),
  // UNIQUE(customer_id, stripe_customer_id) — enforced in SQL migration
})

// Every email Winback has sent
export const emailsSent = pgTable('wb_emails_sent', {
  id:             uuid('id').primaryKey().defaultRandom(),
  subscriberId:   uuid('subscriber_id').notNull().references(() => churnedSubscribers.id, { onDelete: 'cascade' }),
  gmailMessageId: text('gmail_message_id'),  // Resend message ID (legacy column name)
  gmailThreadId:  text('gmail_thread_id'),  // Resend message ID (legacy column name)
  type:           text('type').notNull(),  // exit|win_back|followup
  subject:        text('subject'),
  sentAt:         timestamp('sent_at').defaultNow(),
  repliedAt:      timestamp('replied_at'),
})

// Confirmed subscriber recoveries (used for billing)
export const recoveries = pgTable('wb_recoveries', {
  id:                uuid('id').primaryKey().defaultRandom(),
  subscriberId:      uuid('subscriber_id').notNull().references(() => churnedSubscribers.id),
  customerId:        uuid('customer_id').notNull().references(() => customers.id),
  recoveredAt:       timestamp('recovered_at').defaultNow(),
  planMrrCents:      integer('plan_mrr_cents').notNull(),
  newStripeSubId:    text('new_stripe_sub_id'),
  attributionEndsAt: timestamp('attribution_ends_at').notNull(),  // 12 months from recovery
  stillActive:       boolean('still_active').default(true),
  lastCheckedAt:     timestamp('last_checked_at').defaultNow(),
})
```

---

## Step 3 — Migration SQL

Create `src/winback/migrations/001_initial.sql`. Show this to human before running.

```sql
CREATE TABLE IF NOT EXISTS wb_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wb_customers (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL UNIQUE REFERENCES wb_users(id) ON DELETE CASCADE,
  stripe_account_id    TEXT,
  stripe_access_token  TEXT,
  gmail_refresh_token  TEXT,
  gmail_email          TEXT,
  founder_name         TEXT,
  product_name         TEXT,
  changelog_text       TEXT,
  onboarding_complete  BOOLEAN DEFAULT FALSE,
  plan                 TEXT DEFAULT 'trial',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wb_churned_subscribers (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES wb_customers(id) ON DELETE CASCADE,
  stripe_customer_id    TEXT NOT NULL,
  email                 TEXT,
  name                  TEXT,
  plan_name             TEXT,
  mrr_cents             INTEGER NOT NULL DEFAULT 0,
  tenure_days           INTEGER,
  ever_upgraded         BOOLEAN DEFAULT FALSE,
  near_renewal          BOOLEAN DEFAULT FALSE,
  payment_failures      INTEGER DEFAULT 0,
  previous_subs         INTEGER DEFAULT 0,
  stripe_enum           TEXT,
  stripe_comment        TEXT,
  reply_text            TEXT,
  cancellation_reason   TEXT,
  cancellation_category TEXT,
  tier                  INTEGER,
  confidence            DECIMAL(3,2),
  trigger_keyword       TEXT,
  win_back_subject      TEXT,
  win_back_body         TEXT,
  status                TEXT DEFAULT 'pending',
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(customer_id, stripe_customer_id)
);

CREATE TABLE IF NOT EXISTS wb_emails_sent (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id    UUID NOT NULL REFERENCES wb_churned_subscribers(id) ON DELETE CASCADE,
  gmail_message_id TEXT,
  gmail_thread_id  TEXT,
  type             TEXT NOT NULL,
  subject          TEXT,
  sent_at          TIMESTAMPTZ DEFAULT NOW(),
  replied_at       TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS wb_recoveries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_id       UUID NOT NULL REFERENCES wb_churned_subscribers(id),
  customer_id         UUID NOT NULL REFERENCES wb_customers(id),
  recovered_at        TIMESTAMPTZ DEFAULT NOW(),
  plan_mrr_cents      INTEGER NOT NULL,
  new_stripe_sub_id   TEXT,
  attribution_ends_at TIMESTAMPTZ NOT NULL,
  still_active        BOOLEAN DEFAULT TRUE,
  last_checked_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_churned_customer  ON wb_churned_subscribers(customer_id);
CREATE INDEX IF NOT EXISTS idx_churned_status    ON wb_churned_subscribers(status);
CREATE INDEX IF NOT EXISTS idx_churned_keyword   ON wb_churned_subscribers(trigger_keyword) WHERE trigger_keyword IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_emails_thread     ON wb_emails_sent(gmail_thread_id)         WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recoveries_active ON wb_recoveries(customer_id)              WHERE still_active = TRUE;
```

⛔ **CHECKPOINT: Show this SQL and the target database URL. Ask: "Ready to run migration? Type 'yes'."**

After approval:
```bash
psql $DATABASE_URL -f src/winback/migrations/001_initial.sql
psql $DATABASE_URL -c "\dt wb_*"
# Must list: wb_users, wb_customers, wb_churned_subscribers, wb_emails_sent, wb_recoveries
```

---

## Step 4 — src/winback/lib/types.ts

```typescript
export type SubscriberStatus = 'pending' | 'contacted' | 'recovered' | 'lost'
export type EmailType        = 'exit' | 'win_back' | 'followup'

export interface SubscriberSignals {
  stripeCustomerId: string
  email:            string | null
  name:             string | null
  planName:         string
  mrrCents:         number
  tenureDays:       number
  everUpgraded:     boolean
  nearRenewal:      boolean
  paymentFailures:  number
  previousSubs:     number
  stripeEnum:       string | null
  stripeComment:    string | null
  cancelledAt:      Date
}

export interface ClassificationResult {
  tier:                 1 | 2 | 3 | 4
  tierReason:           string
  cancellationReason:   string      // short phrase shown in dashboard table
  cancellationCategory: string      // Competitor|Price|Quality|Unused|Feature|Other
  confidence:           number      // 0.0–1.0
  suppress:             boolean     // true = no email (tier 4)
  suppressReason?:      string
  firstMessage: {
    subject:        string
    body:           string
    sendDelaySecs:  number          // typically 60
  }
  triggerKeyword:  string | null    // word to watch for in future changelogs
  fallbackDays:    30 | 90 | 180   // send generic follow-up if no trigger fires
  winBackSubject:  string
  winBackBody:     string
}

export interface DashboardStats {
  recoveryRate:       number   // percentage 0–100
  recovered:          number   // count this month
  mrrRecoveredCents:  number   // total MRR recovered this month
  atRisk:             number   // count of pending + contacted
}
```

---

## Step 5 — lib/auth.ts

```typescript
import NextAuth, { type NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import bcrypt from 'bcryptjs'
import { db } from './db'
import { users } from './schema'
import { eq } from 'drizzle-orm'

export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  pages:   { signIn: '/login' },
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email:    { label: 'Email',    type: 'email'    },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, credentials.email))
          .limit(1)

        if (!user) return null

        const valid = await bcrypt.compare(credentials.password, user.passwordHash)
        if (!valid) return null

        return { id: user.id, email: user.email, name: user.name }
      },
    }),
  ],
  callbacks: {
    jwt({ token, user })         { if (user) token.id = user.id; return token },
    session({ session, token })  { if (session.user) session.user.id = token.id as string; return session },
  },
}
```

Create `app/api/auth/[...nextauth]/route.ts`:
```typescript
import NextAuth from 'next-auth'
import { authOptions } from '@/lib/auth'
const handler = NextAuth(authOptions)
export { handler as GET, handler as POST }
```

Create `app/api/auth/register/route.ts`:
- Accept `POST { name, email, password }`
- Validate with Zod: email valid, password ≥ 8 chars, name not empty
- Check if email taken → 409 `{ error: 'Email already registered' }`
- Hash: `bcrypt.hash(password, 12)`
- Insert into `wb_users`
- Return 201 `{ success: true }`

Create `types/next-auth.d.ts`:
```typescript
import 'next-auth'
import 'next-auth/jwt'
declare module 'next-auth'     { interface Session { user: { id: string; email: string; name?: string | null } }; interface User { id: string } }
declare module 'next-auth/jwt' { interface JWT { id: string } }
```

---

## Step 6 — Design system components

### components/logo.tsx
Blue `rounded-xl` square (`bg-blue-600`, `w-8 h-8`) containing a white lightning bolt SVG.
"Winback" in `font-semibold text-slate-900` beside it.
Wraps in `<Link href={href}>` where `href` defaults to `"/"`.
Optional `size` prop: `'sm'` (w-7 h-7 text-base) or `'md'` (w-8 h-8 text-lg, default).

### components/status-badge.tsx
Props: `status: 'pending' | 'contacted' | 'recovered' | 'lost'`

```
recovered → bg-green-50 text-green-700 border-green-200  icon: ✓
contacted → bg-blue-50  text-blue-700  border-blue-200   icon: ✉
pending   → bg-amber-50 text-amber-700 border-amber-200  icon: ○
lost      → bg-slate-100 text-slate-500 border-slate-200 icon: ×
```
Base classes: `inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border`

### components/top-nav.tsx
`'use client'` component. Sticky white nav bar with `border-b border-slate-100`.

```
Left:   <Logo />
Centre: <Link href="/dashboard"> and <Link href="/settings">
        Active = bg-[#0f172a] text-white rounded-full px-4 py-1.5 text-sm font-medium
        Inactive = text-slate-500 hover:text-slate-900
Right:  User avatar (blue-600 circle, first initial) + username + logout icon
        Logout: signOut({ callbackUrl: '/login' }) from next-auth/react
```

Props: `userName?: string | null`
Use `usePathname()` to detect active tab.

### components/step-progress.tsx
Three steps: `[Connect Stripe] [Paste changelog] [Review first e…]`

Props: `currentStep: 1 | 2 | 3`, `completedSteps: number[]`

Container: `flex items-center bg-white rounded-2xl border border-slate-100 p-2 gap-1 max-w-2xl w-full`

Each step pill: `flex items-center gap-2.5 px-4 py-2.5 rounded-xl flex-1`
- Active step adds `bg-blue-50`

Circle icon (w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold):
- Completed: `bg-green-100 text-green-600` showing `✓`
- Active:    `bg-blue-600 text-white` showing step number
- Inactive:  `bg-slate-100 text-slate-400` showing step number

Labels inside each pill:
- `text-[10px] font-semibold uppercase tracking-widest text-slate-400` → "STEP N"
- `text-xs font-semibold` → step name (active: `text-slate-900`, inactive: `text-slate-400`)

---

## Definition of done
- [ ] `lib/db.ts` — Neon connected
- [ ] `lib/schema.ts` — 5 tables defined
- [ ] Migration ran — all 5 `wb_*` tables confirmed in database
- [ ] `src/winback/lib/types.ts` — all interfaces exported
- [ ] `lib/auth.ts` — NextAuth configured
- [ ] Auth API routes created
- [ ] `types/next-auth.d.ts` — session type extended
- [ ] 4 shared components created
- [ ] `npx tsc --noEmit` → zero errors

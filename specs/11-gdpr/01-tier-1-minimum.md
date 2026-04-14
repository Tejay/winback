# Tier 1 — Minimum Legal

**Status:** [ ] Not started
**Depends on:** Spec 04 (webhook/email), Spec 08 (reactivation links), Spec 10 (durable processing)
**Trigger to start:** Ready for EU launch
**Estimated effort:** ~1 day

## Goal

Ship the minimum legal surface to operate in the EU: data subject opt-out, mandatory disclosures (privacy, terms, DPA, subprocessors), processor contract at signup, Anthropic zero-retention. Manual DSR handling via inbox + script is legally sufficient at current volume (Art. 12(3) 30-day window).

## Checklist

- [ ] T1.A.1 — `do_not_contact` migration + schema update
- [ ] T1.A.2 — Unsubscribe route + HMAC token lib + `/unsubscribed` page
- [ ] T1.A.3 — Pipeline guards in `email.ts`, changelog route, Spec 10 worker
- [ ] T1.A.4 — Unsubscribe link in email body
- [ ] T1.A.5 — `List-Unsubscribe` headers on Resend sends
- [ ] T1.A.6 — Anthropic zero-retention header + test
- [ ] T1.A.7 — Signup clickwrap + `wb_legal_acceptances` table
- [ ] T1.B — `/privacy`, `/terms`, `/dpa`, `/subprocessors` pages
- [ ] T1.C — Fill in four governance markdown docs in `docs/gdpr/`
- [ ] T1.D — `privacy@winbackflow.co` inbox + `scripts/dsr.ts`

## T1.A — Schema & pipeline

### T1.A.1 `do_not_contact` flag

Migration `src/winback/migrations/005_gdpr.sql`:
```sql
ALTER TABLE wb_churned_subscribers
  ADD COLUMN do_not_contact    boolean     NOT NULL DEFAULT false,
  ADD COLUMN unsubscribed_at   timestamptz;
```
Reflect in `lib/schema.ts`.

### T1.A.2 Unsubscribe route

**New:** `app/api/unsubscribe/[subscriberId]/route.ts` — GET verifies HMAC token, sets `do_not_contact=true`, `unsubscribed_at=now()`, redirects to `/unsubscribed`. Returns 400 on invalid token.

Token = HMAC-SHA256 of `subscriberId` using `NEXTAUTH_SECRET`. Stateless, per-subscriber, non-guessable.

**New:** `app/unsubscribed/page.tsx` — static confirmation page.
**New:** `src/winback/lib/unsubscribe-token.ts` — `generateUnsubscribeToken(id)` / `verifyUnsubscribeToken(id, token)`.

### T1.A.3 Pipeline guards

In `src/winback/lib/email.ts`, before every send:
```typescript
const [sub] = await db.select({ dnc: churnedSubscribers.do_not_contact })
  .from(churnedSubscribers).where(eq(churnedSubscribers.id, subscriberId)).limit(1)
if (sub?.dnc) { console.log('Skipping — unsubscribed:', subscriberId); return }
```

Applies to `scheduleExitEmail`, `sendDunningEmail`, `app/api/changelog/route.ts`, and the Spec 10 worker's claim step (mark `lost` instead of processed).

### T1.A.4 Unsubscribe link in body

Append after reactivation link:
```
— — —
If you'd rather not hear from us, unsubscribe: https://winbackflow.co/api/unsubscribe/{id}?t={token}
```

### T1.A.5 `List-Unsubscribe` headers

On every Resend send:
```typescript
headers: {
  'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@winbackflow.co>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
}
```

### T1.A.6 Anthropic zero-retention

In `src/winback/lib/classifier.ts` `getClient()`:
```typescript
return new Anthropic({
  apiKey,
  defaultHeaders: { 'anthropic-beta': 'zero-retention' },
})
```
Add unit test that fails if the header regresses.

### T1.A.7 Signup clickwrap

`app/register/page.tsx` — checkbox *"I accept the [Terms](/terms), [Privacy Policy](/privacy), and [Data Processing Agreement](/dpa)"*. Block submission if unchecked.

`app/api/auth/register/route.ts` — after user insert, insert:
```typescript
await db.insert(legalAcceptances).values({
  userId: newUser.id,
  version: LEGAL_VERSION,
  ipAddress: req.headers.get('x-forwarded-for') ?? null,
})
```

Migration:
```sql
CREATE TABLE wb_legal_acceptances (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES wb_users(id) ON DELETE CASCADE,
  version      text NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  ip_address   text
);
```

`LEGAL_VERSION = "2026-04-14"` constant (bump when any legal doc changes — Tier 2 re-accept flow uses this).

## T1.B — Public pages

- **`app/privacy/page.tsx`** — who we are, data processed (email, name, cancellation reason, reply text, Stripe customer ID), purposes + lawful basis (legitimate interest for re-engagement, contract for service), subprocessors link, SCCs, retention (2y or on account closure), subject rights + privacy@ contact, Art. 22 disclosure (LLM classification, no legal/significant effects, unsubscribe available).
- **`app/terms/page.tsx`** — standard SaaS terms adapted to £49/mo + 10% recovered MRR pricing.
- **`app/dpa/page.tsx`** — Art. 28 clauses: scope, duration, data categories + subject categories, controller/processor obligations, subprocessor auth (reference `/subprocessors`), Art. 32 security, DSR cooperation (30d), breach notification, audit rights, return/deletion on termination, SCCs appendix.
- **`app/subprocessors/page.tsx`** — table rendered from `src/winback/lib/subprocessors.ts`:

```typescript
export const SUBPROCESSORS = [
  { name: 'Vercel',    purpose: 'Hosting + serverless compute',    location: 'USA', dpa: 'https://vercel.com/legal/dpa' },
  { name: 'Neon',      purpose: 'Database',                        location: 'USA', dpa: 'https://neon.tech/dpa' },
  { name: 'Anthropic', purpose: 'LLM classification (zero retn.)', location: 'USA', dpa: 'https://www.anthropic.com/legal/dpa' },
  { name: 'Resend',    purpose: 'Email delivery',                  location: 'USA', dpa: 'https://resend.com/legal/dpa' },
  { name: 'Stripe',    purpose: 'OAuth customer data read',        location: 'USA', dpa: 'https://stripe.com/legal/dpa' },
]
```

## T1.C — Governance docs

Flesh out the stubs in `docs/gdpr/`:
- `ropa.md` — Records of Processing Activities (Art. 30). Use ICO template.
- `breach-response.md` — detect → contain → assess → notify controllers <72h → document.
- `retention-policy.md` — 2y for subscriber data; purged on controller account closure; quarterly manual cleanup until Tier 3 automates.
- `privacy-auto-reply.md` — auto-reply template for `privacy@`.

## T1.D — Privacy inbox

1. Set up `privacy@winbackflow.co` → forwards to founder's inbox. Configure auto-reply from `docs/gdpr/privacy-auto-reply.md`.
2. `scripts/dsr.ts`:
   ```
   npx tsx scripts/dsr.ts export user@example.com
   npx tsx scripts/dsr.ts delete user@example.com
   ```
   Exports all rows referencing the email across `churned_subscribers`, `emails_sent`, `recoveries` as JSON. Delete cascades + logs action.

## Files to create / modify

**Create:**
- `app/api/unsubscribe/[subscriberId]/route.ts`
- `app/unsubscribed/page.tsx`
- `app/privacy/page.tsx`
- `app/terms/page.tsx`
- `app/dpa/page.tsx`
- `app/subprocessors/page.tsx`
- `src/winback/lib/subprocessors.ts`
- `src/winback/lib/unsubscribe-token.ts`
- `src/winback/migrations/005_gdpr.sql`
- `scripts/dsr.ts`

**Modify:**
- `lib/schema.ts` — new columns + `wb_legal_acceptances` table
- `src/winback/lib/email.ts` — `do_not_contact` guard, unsub link, `List-Unsubscribe` header
- `src/winback/lib/classifier.ts` — zero-retention header
- `app/api/changelog/route.ts` — filter out `do_not_contact = true`
- `app/register/page.tsx` — clickwrap checkbox
- `app/api/auth/register/route.ts` — write to `wb_legal_acceptances`
- `app/api/internal/process-subscriber/[id]/route.ts` (Spec 10) — honour `do_not_contact`

**Fill in (created as stubs by scaffold):**
- `docs/gdpr/ropa.md`
- `docs/gdpr/breach-response.md`
- `docs/gdpr/retention-policy.md`
- `docs/gdpr/privacy-auto-reply.md`

## Verification

- [ ] Unit: `unsubscribe-token.test.ts` — HMAC round-trip, tampered token rejected.
- [ ] Unit: `email.test.ts` — `do_not_contact` rows skip sending, `List-Unsubscribe` header present, unsub link in body.
- [ ] Unit: `classifier.test.ts` — `anthropic-beta: zero-retention` header present.
- [ ] Integration: register test user → `wb_legal_acceptances` row created.
- [ ] Integration: trigger synthetic churn → email contains unsub link.
- [ ] Integration: click unsub link → `do_not_contact=true`, `/unsubscribed` renders.
- [ ] Integration: re-trigger churn for same subscriber → no email sent.
- [ ] Manual: `/privacy`, `/terms`, `/dpa`, `/subprocessors` render with mandated content.
- [ ] Manual: DPA clickwrap at signup blocks submission if unchecked.
- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes

## Rollback plan

- Migration `005_gdpr.sql`:
  ```sql
  DROP TABLE wb_legal_acceptances;
  ALTER TABLE wb_churned_subscribers DROP COLUMN do_not_contact, DROP COLUMN unsubscribed_at;
  ```
- Unsubscribe route — delete files, revert email template changes.
- Zero-retention header — one-line revert in `classifier.ts`.

## Deferred decisions

Populate as we go. Examples:
- Rectification handled email-only in Tier 1; self-serve deferred to Tier 2.
- No `data_region` column yet; all data in US region. Deferred to Tier 4.

## Commit

On merge, update `specs/11-gdpr/README.md`:
```
| 1 — Minimum legal | [x] Shipped (commit: <sha>) | ... |
```

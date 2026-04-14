# Tier 2 — Operational Hygiene

**Status:** [ ] Not started
**Depends on:** Tier 1
**Trigger to start:** DSR volume > 2/month, OR first enterprise prospect asks for self-serve subject portal, OR subprocessor list changes.
**Estimated effort:** ~2 days on top of Tier 1

## Goal

Reduce founder toil once DSR volume or customer pressure exceeds manual handling. Move from email-driven + manual scripts to self-serve flows and automated customer notifications.

## Checklist

- [ ] T2.A — Self-serve DSR portal for data subjects
- [ ] T2.B — Versioned legal + re-accept banner
- [ ] T2.C — Subprocessor change notifications via GitHub Action
- [ ] T2.D — Breach declaration workflow

## T2.A — Self-serve DSR portal

**New pages:** `app/dsr/request/page.tsx`, `app/dsr/[token]/page.tsx`

Flow:
1. Subject submits email at `/dsr/request` (or clicks link embedded in every exit email).
2. We HMAC-sign a token bound to `email + expiry` (7 days), emailed to them — proves email control.
3. Verified link lands on `/dsr/[token]` with three buttons:
   - **Export** — JSON dump across `churned_subscribers`, `emails_sent`, `recoveries`
   - **Rectify** — inline form to correct their email/name
   - **Delete** — cascading delete across all tables, writes audit entry

**New table:**
```sql
CREATE TABLE wb_dsr_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  token_hash   text NOT NULL,
  action       text NOT NULL, -- 'export' | 'delete' | 'rectify'
  status       text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
```

**New files:** `app/api/dsr/request/route.ts`, `app/api/dsr/[token]/route.ts`, `src/winback/lib/dsr.ts` (exposes `exportSubject`, `deleteSubject`, `rectifySubject`).

## T2.B — Versioned legal + re-accept banner

When `LEGAL_VERSION` bumps:
- Compare user's most recent `wb_legal_acceptances.version` to current.
- If stale, show dismiss-blocking banner on `/dashboard` linking to a diff page.
- Insert new acceptance row on accept.

**New:** `components/legal-banner.tsx`, `app/legal/changes/page.tsx` (renders diff from `docs/gdpr/legal-history/`).

Snapshot `/privacy`, `/terms`, `/dpa` into `docs/gdpr/legal-history/<version>/` on every bump.

## T2.C — Subprocessor change notifications

GitHub Action on merge to `main` diffs `src/winback/lib/subprocessors.ts`. If changed:
- Emails all customers via Resend with the diff.
- Default 30-day notice window before activation (configurable per-customer later).

**New:** `.github/workflows/subprocessor-notify.yml`, `scripts/notify-subprocessor-change.ts`.

## T2.D — Breach declaration workflow

**New:** `app/internal/breach/page.tsx` (founder-only, auth-gated) — form captures:
- What happened
- Scope (affected customer IDs)
- Data categories involved
- Detection + containment timeline
- Remediation

On submit:
- Writes to `wb_breach_incidents`.
- Auto-drafts notification emails to affected customers (founder reviews + sends via Resend).
- Starts 72h countdown timer.

```sql
CREATE TABLE wb_breach_incidents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at   timestamptz NOT NULL,
  reported_at   timestamptz,
  scope         jsonb NOT NULL,
  description   text NOT NULL,
  remediation   text,
  status        text NOT NULL DEFAULT 'open'
);
```

## Verification

- [ ] Subject requests export via link → receives JSON with all their rows.
- [ ] Subject deletes → rows removed across tables + audit log entry.
- [ ] `LEGAL_VERSION` bump → banner shown until re-accepted.
- [ ] Add a subprocessor to the list → GitHub Action drafts notification email.
- [ ] File a test breach → 72h timer + draft emails generated.
- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes

## Rollback plan

- `DROP TABLE wb_dsr_requests, wb_breach_incidents;`
- Remove banner component; revert dashboard page.
- Disable GitHub Action.

## Deferred decisions

(Populated during execution.)

# Tier 3 — Defensibility

**Status:** [ ] Not started
**Depends on:** Tier 2
**Trigger to start:** First audit request from a customer, regulator complaint, or MRR > £10k/mo.
**Estimated effort:** ~3 days on top of Tier 2

## Goal

Produce evidence for auditors, SOC2-adjacent customers, and regulators. Move from "we say we comply" to "here's the audit trail that proves it."

## Checklist

- [ ] T3.A — Access audit log (`wb_audit_log` table + `src/winback/lib/audit.ts`)
- [ ] T3.B — Automated retention cron
- [ ] T3.C — Auto-generated ROPA
- [ ] T3.D — DPIA documentation
- [ ] T3.E — Security posture doc

## T3.A — Access audit log

Every read/write touching subscriber PII logs a row.

```sql
CREATE TABLE wb_audit_log (
  id          bigserial PRIMARY KEY,
  actor_type  text NOT NULL,   -- 'user' | 'system' | 'dsr' | 'cron'
  actor_id    text,
  action      text NOT NULL,   -- 'read' | 'write' | 'delete' | 'export'
  resource    text NOT NULL,   -- 'churned_subscriber' | ...
  resource_id text,
  metadata    jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_resource ON wb_audit_log(resource, resource_id);
CREATE INDEX idx_audit_at ON wb_audit_log(at);
```

**New:** `src/winback/lib/audit.ts` — `logAccess({ actor, action, resource, resourceId, metadata })`.

Wire into:
- Dashboard subscriber table reads (`app/api/subscribers/route.ts`)
- DSR exports / deletes (`src/winback/lib/dsr.ts`)
- Webhook processing (`app/api/stripe/webhook/route.ts`)
- Retention cron

## T3.B — Automated retention cron

Add to `vercel.ts`:
```typescript
crons: [{ path: '/api/cron/retention', schedule: '0 3 * * *' }]
```

**New:** `app/api/cron/retention/route.ts`:
- Delete `churned_subscribers` where `created_at < now() - 2y` AND `status != 'recovered'`.
- Recovered rows kept 1y past `attributionEndsAt` for MRR audit, then deleted.
- Delete `emails_sent` older than 2y.
- Delete/aggregate `wb_audit_log` rows older than 2y.
- Cascade on controller (`wb_customers`) account closure.
- Log deletion counts to `wb_audit_log`.

## T3.C — Auto-generated ROPA

**New:** `app/internal/ropa/page.tsx` (founder-only) — renders ROPA live from:
- Schema introspection (data categories per table)
- `SUBPROCESSORS` constant (recipients + transfers)
- `RETENTION_POLICY` constant (periods)
- Static copy for lawful basis + purposes

PDF export via `@react-pdf/renderer`. `docs/gdpr/ropa.md` becomes the fallback / template.

## T3.D — DPIA documentation

**New:** flesh out `docs/gdpr/dpia.md` covering:
- Description of processing (automated classification of cancellation reason)
- Necessity + proportionality
- Risks to rights + freedoms (profiling, re-engagement pressure)
- Mitigations (opt-out, no legal effects, human oversight via reply flow)

Required when regulators ask; cheap to write once.

## T3.E — Security posture doc

**New:** flesh out `docs/gdpr/security.md` covering:
- TLS everywhere, HSTS
- Token encryption at rest (AES-128-GCM, `ENCRYPTION_KEY`)
- Neon encryption at rest
- Access control (NextAuth JWT, route-level session checks)
- Anthropic zero-retention
- Incident response reference
- Pen-test artefacts (once commissioned)

Linked from `/privacy` and `/dpa`. Basis for enterprise security questionnaires.

## Verification

- [ ] Dashboard view → audit row created with actor + resource.
- [ ] Seed 3y-old subscriber → retention cron deletes + logs.
- [ ] Delete a customer → all subscriber rows cascaded, logged.
- [ ] `/internal/ropa` renders complete list with all tables and subprocessors.
- [ ] DPIA + security docs reviewed by external counsel (manual gate).
- [ ] `npx tsc --noEmit` passes
- [ ] `npx vitest run` passes

## Rollback plan

- `DROP TABLE wb_audit_log;`
- Remove cron entry from `vercel.ts`.
- Remove audit call sites (grep for `logAccess`).

## Deferred decisions

(Populated during execution.)

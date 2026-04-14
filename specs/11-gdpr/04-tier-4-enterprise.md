# Tier 4 — Enterprise Posture

**Status:** [ ] Not started
**Depends on:** Tier 3
**Trigger to start:** Enterprise pipeline justifies ~£35k+/year spend (pen-test + SOC2 + DPO + EU residency infra).
**Estimated effort:** ~1 week of engineering + 6 months of compliance process

## Goal

Win regulated industries, EU-only tenants, and enterprise buyers running vendor risk programs. Move from "compliant" to "audited and attested."

## Checklist

- [ ] T4.A — EU data residency option
- [ ] T4.B — Negotiated DPAs + SCCs with signed-copy storage
- [ ] T4.C — Customer-facing trust portal
- [ ] T4.D — DPO designation (external fractional)
- [ ] T4.E — Pen-test + SOC2 roadmap
- [ ] T4.F — EU representative (Art. 27)

## T4.A — EU data residency

Per-customer flag `data_region` in `wb_customers` (`us` | `eu`, default `us`).

When `eu`:
- Subscriber data writes to EU-region Neon branch (`DATABASE_URL_EU`).
- Anthropic EU endpoint (when GA) or fallback to redacted classification.
- Resend EU region configured.
- Vercel functions deployed to `fra1` / `dub1`.

**Modify:** `lib/db.ts` becomes region-aware, routing based on `customer.data_region`. Separate connection pool per region.

## T4.B — Negotiated DPAs + SCCs

- Template DPA supports redlines (mark as negotiated in `wb_legal_acceptances.version`).
- SCC module selection per customer:
  - **Module 2** — Controller to Processor (most common)
  - **Module 3** — Processor to Processor (when customer is itself a processor)
- Signed copies in blob storage (`wb_signed_contracts` table with URL + SHA256 hash).

```sql
CREATE TABLE wb_signed_contracts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES wb_customers(id) ON DELETE CASCADE,
  type         text NOT NULL, -- 'dpa' | 'scc' | 'msa'
  version      text NOT NULL,
  blob_url     text NOT NULL,
  sha256       text NOT NULL,
  signed_at    timestamptz NOT NULL DEFAULT now()
);
```

## T4.C — Customer trust portal

**New:** `app/trust/page.tsx` (public) — one-stop view:
- Current subprocessors + notice window
- Historical legal doc versions (diff view)
- Security posture summary (from `docs/gdpr/security.md`)
- Pen-test attestation
- SOC2 / ISO status (once obtained)
- Live uptime / incident history (Vercel Statuspage integration)
- DPA + SCC download links

Becomes the URL you send to enterprise procurement teams.

## T4.D — DPO designation

Art. 37 triggers don't currently apply (no public body, no large-scale systematic monitoring, no large-scale special-category processing). Becomes required at enterprise scale or if special-category data added.

- Designate external fractional DPO (~£500/mo).
- DPO contact listed in `/privacy`, `/dpa`, `/trust`.
- Quarterly compliance review meeting, minutes stored in `docs/gdpr/dpo-reviews/`.

## T4.E — Pen-test + SOC2 roadmap

- Annual external pen-test (~£5k).
- SOC2 Type I → Type II (~£30k + 6mo via Drata / Vanta).
- ISO 27001 follows if UK/EU enterprise pressure justifies.

Not code — budget + schedule. Track in `docs/gdpr/audits.md`.

## T4.F — EU representative (Art. 27)

Required if we have no EU establishment and process EU subjects' data (we do, via customers).

- Service like ePrivacy GmbH (~£1k/yr).
- Contact listed in privacy policy and `/trust`.

## Verification

- [ ] Customer with `data_region='eu'` → writes land in EU Neon branch; audit log confirms no cross-region reads.
- [ ] Download signed DPA → hash matches stored copy.
- [ ] `/trust` renders all sections with live data.
- [ ] External DPO audit produces no P1/P2 findings.
- [ ] Pen-test report filed.
- [ ] SOC2 Type I report issued.

## Rollback plan

- Region-aware routing can fall back to single-region by setting all `data_region='us'`.
- DPO, pen-test, SOC2 — contractual, not code.

## Deferred decisions

(Populated during execution.)

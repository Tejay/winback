# Breach Response Runbook

**GDPR Art. 33** — notify controllers within 72h of awareness. Filled in during Tier 1.

> Stub — populated as part of Tier 1.

## 1. Detect
Sources: Vercel logs, Neon alerts, customer report, security researcher.

## 2. Contain
- Rotate affected secrets (`ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, Stripe/Resend/Anthropic keys).
- Revoke suspect OAuth tokens.
- Disable affected endpoints if needed.

## 3. Assess
- Scope: which customers, which subjects, which data categories?
- Severity: likelihood + impact on rights and freedoms.
- Document timeline: detection, containment, assessment.

## 4. Notify
- **Controllers (our customers)** — within 72h of awareness. Email: nature, scope, likely consequences, measures taken.
- Controllers notify their data subjects (their obligation, not ours).
- If we decide we are controller for any subset, notify supervisory authority within 72h.

## 5. Document
- Incident entry in `wb_breach_incidents` (Tier 2+) or `docs/gdpr/incidents/<date>.md` (Tier 1).
- Root cause, remediation, prevention.

# Security Posture

**GDPR Art. 32.** Filled in during Tier 3.

> Stub — reserved for Tier 3 execution. Linked from `/privacy` and `/dpa` once populated.

Sections to complete:
- Transport security (TLS everywhere, HSTS)
- Token encryption at rest (AES-128-GCM, `ENCRYPTION_KEY`)
- Database encryption at rest (Neon managed)
- Access control (NextAuth JWT, route-level session checks)
- LLM data handling (Anthropic zero-retention header)
- Secrets management (Vercel env vars, no secrets in repo)
- Incident response (see `breach-response.md`)
- Pen-test artefacts (once commissioned — Tier 4)

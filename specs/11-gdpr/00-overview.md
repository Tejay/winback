# GDPR — Overview & Article Traceability

## Context

Winback processes personal data of EU data subjects (churned subscribers of our customers). We act as a **processor** on behalf of our customers (controllers). The subjects themselves are not our users — they are our customers' users.

Consequences:
- Our customers' privacy policies cover the subjects; we need a DPA with our customers (Art. 28).
- Subjects' DSRs usually come to our customers first; we must cooperate within 30 days (Art. 12(3)).
- Our lawful basis for re-engagement emails is **legitimate interest** (Art. 6(1)(f)) with a clear opt-out (Art. 21 + PECR `List-Unsubscribe`).

GDPR compliance is layered. Tier 1 unblocks EU launch. Tiers 2–4 are built on demand when volume or enterprise pressure justifies the work. Each tier is a separate spec file and a separate PR.

## Tier map

| Tier | Purpose | Trigger | Effort |
|------|---------|---------|--------|
| 1 | Minimum legal | EU launch | 1d |
| 2 | Operational hygiene | DSR > 2/mo, or enterprise prospect, or subprocessor churn | 2d |
| 3 | Defensibility | Audit request, regulator, or MRR > £10k/mo | 3d |
| 4 | Enterprise posture | Enterprise pipeline justifies £35k+/yr | 1w |

## Article traceability

| Article | Requirement | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|---|
| Art. 5 | Data minimisation, accuracy, storage limits | Policy doc | — | Retention cron | — |
| Art. 6 | Lawful basis | Privacy policy | — | — | — |
| Art. 13/14 | Inform data subjects | `/privacy` | Versioned + re-accept | — | Trust portal |
| Art. 15 | Right of access | Manual script | Self-serve export | Audit log of access | — |
| Art. 16 | Right to rectification | Manual script | Self-serve edit | — | — |
| Art. 17 | Right to erasure | Manual script | Self-serve delete | Retention cron | — |
| Art. 20 | Data portability | Manual JSON export | Self-serve export | — | — |
| Art. 21 + PECR | Right to object, marketing consent | `do_not_contact` + unsub link | — | — | — |
| Art. 22 | Automated decision-making | Disclosed in privacy policy | — | — | — |
| Art. 25 | Privacy by design | Existing (token encryption, TLS) | — | DPIA doc | — |
| Art. 28 | Processor contract | `/dpa` clickwrap | Versioned re-accept | — | Negotiated SCCs |
| Art. 28(2) | Subprocessor authorisation | `/subprocessors` page | Change notification emails | — | — |
| Art. 30 | Records of Processing Activities | `docs/gdpr/ropa.md` | — | Auto-generated ROPA | — |
| Art. 32 | Security | Existing (TLS, encryption, Neon at-rest) | — | Pen-test artefacts | SOC2 / ISO |
| Art. 33 | Breach notification (72h) | `docs/gdpr/breach-response.md` | Breach declaration UI | Incident audit trail | — |
| Art. 35 | DPIA for high-risk processing | — | — | DPIA doc | — |
| Art. 37 | DPO | — | — | — | DPO role |
| Art. 44–49 | International transfers | SCCs in policy + DPA | — | — | EU residency option |
| Anthropic | Minimise LLM exposure | Zero-retention header | — | — | — |

## Not building at any tier

- Self-hosted LLM for EU residency (Anthropic zero-retention + SCCs sufficient).
- Homomorphic encryption / differential privacy on subscriber data (disproportionate cost).
- Real-time consent management platform (no marketing cookies — transactional relationship with controllers).
- GDPR-as-a-product features for our customers' end-users (customers' own policies cover their subjects).
